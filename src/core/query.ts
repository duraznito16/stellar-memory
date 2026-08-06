/**
 * Queries over the memory.
 *
 * Both the CLI and the MCP server call into this module, so a developer and an
 * agent asking the same question get the same answer from the same index. That
 * symmetry is the point: the memory is one artefact with two front doors.
 */

import type {
  AssetData,
  ContractData,
  DeploymentData,
  ErrorData,
  FunctionData,
  MemoryEdge,
  MemoryNode,
  NodeKind,
  ProjectMemory,
  StorageData,
  TestData,
} from './types.js';
import { humanAge } from './git.js';

export function nodeById(memory: ProjectMemory, id: string): MemoryNode | undefined {
  return memory.nodes.find((n) => n.id === id);
}

export function nodesOfKind(memory: ProjectMemory, kind: NodeKind): MemoryNode[] {
  return memory.nodes.filter((n) => n.kind === kind);
}

export interface Neighbourhood {
  node: MemoryNode;
  outgoing: { edge: MemoryEdge; node: MemoryNode }[];
  incoming: { edge: MemoryEdge; node: MemoryNode }[];
}

export function neighbourhood(memory: ProjectMemory, id: string): Neighbourhood | null {
  const node = nodeById(memory, id);
  if (!node) return null;
  const byId = new Map(memory.nodes.map((n) => [n.id, n]));

  const outgoing = memory.edges
    .filter((e) => e.from === id)
    .flatMap((edge) => {
      const target = byId.get(edge.to);
      return target ? [{ edge, node: target }] : [];
    });
  const incoming = memory.edges
    .filter((e) => e.to === id)
    .flatMap((edge) => {
      const source = byId.get(edge.from);
      return source ? [{ edge, node: source }] : [];
    });

  return { node, outgoing, incoming };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export interface SearchHit {
  node: MemoryNode;
  score: number;
  /** Why this matched, for display. */
  reason: string;
}

/**
 * Deterministic ranked search. Deliberately simple and explainable: exact title
 * match beats prefix match beats substring beats a hit in the summary or path.
 * No embeddings, so it works offline and its behaviour is predictable.
 */
/**
 * Words that carry no signal in a question about a codebase. Without this,
 * "how does payment work" scores every node containing "work" or "does", and
 * the answer is dominated by whatever kind happens to carry a bonus.
 */
const STOPWORDS = new Set([
  'how', 'does', 'do', 'is', 'are', 'was', 'the', 'a', 'an', 'of', 'in', 'on',
  'to', 'for', 'and', 'or', 'what', 'which', 'where', 'when', 'why', 'who',
  'work', 'works', 'used', 'use', 'uses', 'this', 'that', 'it', 'its', 'with',
  'can', 'i', 'we', 'me', 'my', 'you', 'about', 'into', 'from', 'by', 'be',
]);

/**
 * How useful each kind is as the answer to a question about how a project
 * works. A contract or a function explains something; a deployment address is
 * a fact you look up once you know what you are looking at.
 */
const KIND_WEIGHT: Partial<Record<NodeKind, number>> = {
  contract: 10,
  function: 8,
  storage: 5,
  event: 4,
  error: 4,
  type: 3,
  asset: 3,
  crate: 2,
  deployment: 1,
};

/**
 * The string values inside a node's payload, without the field names.
 *
 * Serialising the payload put the schema into the searchable text: every
 * `FunctionData` carried `"params"` and `"type"`, so a search for the auth shape
 * that lets anyone claim admin returned every function in the project, getters
 * included. A field name says what the index calls something, not what the node
 * is about.
 */
function dataValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) dataValues(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) dataValues(item, out);
  }
  return out;
}

export function search(memory: ProjectMemory, query: string, limit = 20): SearchHit[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return [];
  const allTerms = needle.split(/\s+/).filter((t) => t.length > 1);
  const meaningful = allTerms.filter((t) => !STOPWORDS.has(t));
  // If the question is nothing but stopwords, fall back to them rather than
  // matching nothing at all.
  const terms = meaningful.length > 0 ? meaningful : allTerms;

  const hits: SearchHit[] = [];
  for (const node of memory.nodes) {
    const title = node.title.toLowerCase();
    const summary = (node.summary ?? '').toLowerCase();
    const pathText = (node.path ?? '').toLowerCase();
    const dataText = node.data ? dataValues(node.data).join(' ') : '';

    let score = 0;
    let reason = '';

    if (title === needle) {
      score += 100;
      reason = 'exact name match';
    } else if (title.startsWith(needle)) {
      score += 60;
      reason = 'name starts with the query';
    } else if (title.includes(needle)) {
      score += 40;
      reason = 'name contains the query';
    }

    for (const term of terms) {
      if (title.includes(term)) score += 12;
      // A node names its own kind nowhere else: `DataKey::Admin (instance)` does
      // not contain "storage", so the most obvious query for a storage key
      // matched every function that reads one and none of the keys. The plural
      // is how a person asks for them. Weighted above the summary and below the
      // name, because this ranks — `search_memory`'s `kind` argument is what
      // narrows to one kind, and a function that genuinely reads storage is
      // still an answer here.
      if (term === node.kind || term === `${node.kind}s`) {
        score += 8;
        reason ||= `kind is ${node.kind}`;
      }
      if (summary.includes(term)) {
        score += 6;
        reason ||= 'mentioned in the summary';
      }
      if (pathText.includes(term)) {
        score += 4;
        reason ||= 'path match';
      }
      if (dataText.includes(term)) {
        score += 2;
        reason ||= 'match in structured detail';
      }
    }

    // Break ties toward the kinds that answer a question rather than record a
    // fact. Only ever a tiebreak: a weak match on a contract must not outrank a
    // strong match on a storage key.
    if (score > 0) score += KIND_WEIGHT[node.kind] ?? 0;

    if (score > 0) hits.push({ node, score, reason: reason || 'partial match' });
  }

  return hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit);
}

/**
 * Suggest node ids close to one that was not found.
 *
 * Agents address nodes by id and get them slightly wrong — a typo, the wrong
 * kind prefix, a plural. Substring search cannot recover from a typo, so this
 * falls back to edit distance over both the id and the bare name. Returning a
 * good guess turns a dead end into a working second call.
 */
export function suggestIds(memory: ProjectMemory, wanted: string, limit = 5): string[] {
  const needle = wanted.toLowerCase();
  const local = (needle.includes(':') ? needle.slice(needle.indexOf(':') + 1) : needle).trim();

  const scored: { id: string; distance: number }[] = [];
  for (const node of memory.nodes) {
    const candidates = [node.id.toLowerCase(), node.title.toLowerCase()];
    const localId = node.id.toLowerCase().slice(node.id.indexOf(':') + 1);
    candidates.push(localId);

    let best = Infinity;
    for (const candidate of candidates) {
      best = Math.min(best, editDistance(local, candidate), editDistance(needle, candidate));
    }

    // Tolerate roughly one error per four characters, so short names stay strict.
    const tolerance = Math.max(1, Math.floor(local.length / 4));
    if (best <= tolerance) scored.push({ id: node.id, distance: best });
  }

  return scored
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((s) => s.id);
}

/** Levenshtein distance, bounded by two rolling rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // A large size gap cannot be a near miss; skip the work.
  if (Math.abs(a.length - b.length) > 8) return Infinity;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? Infinity;
}

/* ------------------------------------------------------------------ *
 * Architecture
 * ------------------------------------------------------------------ */

export interface ArchitectureView {
  contracts: {
    node: MemoryNode;
    crate?: string;
    functions: MemoryNode[];
    calls: MemoryNode[];
    calledBy: MemoryNode[];
    deployments: MemoryNode[];
    tests: MemoryNode[];
  }[];
  /** Contracts nothing else calls — the entry points into the system. */
  entryPoints: string[];
}

export function architecture(memory: ProjectMemory): ArchitectureView {
  const byId = new Map(memory.nodes.map((n) => [n.id, n]));
  const contracts = nodesOfKind(memory, 'contract');

  const view: ArchitectureView['contracts'] = contracts.map((node) => {
    const hood = neighbourhood(memory, node.id)!;
    return {
      node,
      crate: (node.data as unknown as ContractData | undefined)?.crate,
      functions: hood.outgoing.filter((o) => o.edge.kind === 'defines' && o.node.kind === 'function').map((o) => o.node),
      calls: hood.outgoing.filter((o) => o.edge.kind === 'calls').map((o) => o.node),
      calledBy: hood.incoming.filter((i) => i.edge.kind === 'calls').map((i) => i.node),
      deployments: hood.outgoing.filter((o) => o.edge.kind === 'deployed_as').map((o) => o.node),
      tests: hood.incoming.filter((i) => i.edge.kind === 'tests').map((i) => i.node),
    };
  });

  const entryPoints = view.filter((c) => c.calledBy.length === 0).map((c) => c.node.title);
  void byId;
  return { contracts: view, entryPoints };
}

/* ------------------------------------------------------------------ *
 * Health signals
 * ------------------------------------------------------------------ */

/**
 * What kind of problem a signal reports. Machine-filterable so a CI gate can
 * fail on the categories a team actually cares about rather than all or nothing.
 */
export type SignalCategory =
  /** Deployed Wasm no longer matches local source. */
  | 'drift'
  /** Persistent storage that can expire and become unreachable. */
  | 'ttl'
  /** A state-changing entry point with no or ineffective authorization. */
  | 'auth'
  /** Error discriminants disagree with what is deployed. */
  | 'abi'
  /** Administrative operations on an asset. */
  | 'value'
  /** Coverage gaps. */
  | 'tests';

export const SIGNAL_CATEGORIES: SignalCategory[] = [
  'drift', 'ttl', 'auth', 'abi', 'value', 'tests',
];

export interface Signal {
  severity: 'info' | 'warn';
  category: SignalCategory;
  message: string;
  nodeId?: string;
  /**
   * The finding is about the project rather than about any one node, so it
   * carries no `nodeId`. Marking it is what stops a reader treating the absence
   * as missing data and pinning it to whichever node happened to come first.
   */
  scope?: 'project';
}

export type DriftState = NonNullable<DeploymentData['drift']>;

/**
 * The one drift rule, so no surface can paint a comparison that never ran as
 * agreement.
 *
 * `unknown` is a third state and not a weaker `in-sync`: it is what a deployment
 * gets when one of the two Wasm hashes is missing — the network was not
 * consulted, or the CLI had no answer — so nothing was compared. An absent
 * `drift` is the same thing said by omission. Every surface used to fold both
 * into "in sync", which claims a check nobody performed.
 */
export function driftState(drift: DeploymentData['drift']): DriftState {
  return drift === 'in-sync' || drift === 'stale' ? drift : 'unknown';
}

/**
 * The word each state is named by. Colour alone cannot carry the difference —
 * the window already commits to that — and three surfaces naming the third state
 * three ways is how they drifted apart the first time.
 */
export const DRIFT_LABEL: Record<DriftState, string> = {
  'in-sync': 'in sync',
  stale: 'stale',
  unknown: 'not checked',
};

/**
 * The one TTL rule, so the note a human reads and the gate CI runs cannot
 * disagree about the same key.
 *
 * Instance entries are deliberately out. `instance().extend_ttl(threshold,
 * extend_to)` names no key — it extends the contract instance as a whole — so
 * the scanner has no entry to record it against and `hasTtlExtension` is false
 * on every instance key however diligently the contract extends it. Warning
 * there is a warning no correct code can clear. The exposure differs too: an
 * instance entry lapses together with the contract's own code, all at once and
 * unmissably, where a persistent entry archives on its own and leaves one value
 * unreachable behind a contract that still answers.
 */
export function missingTtlExtension(data: StorageData): boolean {
  return data.durability === 'persistent' && !data.hasTtlExtension;
}

/**
 * Facts a returning developer would want flagged, all derived from hard data
 * rather than inference: deployments that no longer match source, persistent
 * storage with no TTL extension, contracts with no tests, unauthenticated
 * mutating entry points.
 */
export function signals(memory: ProjectMemory): Signal[] {
  const out: Signal[] = [];

  for (const node of nodesOfKind(memory, 'deployment')) {
    const data = node.data as unknown as DeploymentData | undefined;
    if (driftState(data?.drift) === 'stale') {
      out.push({
        severity: 'warn',
        category: 'drift',
        message: `${node.title} runs a different build than your local source.`,
        nodeId: node.id,
      });
    }
  }

  for (const node of nodesOfKind(memory, 'storage')) {
    const data = node.data as unknown as StorageData | undefined;
    if (data && missingTtlExtension(data)) {
      out.push({
        severity: 'warn',
        category: 'ttl',
        message: `Persistent key ${data.key} is never given an extend_ttl; it can expire and become unreachable.`,
        nodeId: node.id,
      });
    }
  }

  // Whether a function changes state is read from what it actually does, not
  // from what it is called. Guessing by name prefix flagged `payroll_address` —
  // a plain getter — because it begins with "pay".
  //
  // Only writes count. Publishing an event is not a state change: a read-only
  // view that emits a log for indexers needs no authorization, and flagging it
  // was a false positive on entirely correct code.
  const mutatingFunctions = new Set<string>();
  for (const edge of memory.edges) {
    if (edge.kind === 'writes') mutatingFunctions.add(edge.from);
  }

  /** Instance keys this function checks with `has` — the re-init guard. */
  const guardsOf = (fnId: string) =>
    memory.edges.filter((e) => e.from === fnId && e.kind === 'reads' && e.note === '`has`');

  const arch = architecture(memory);
  for (const contract of arch.contracts) {
    if (contract.tests.length === 0) {
      out.push({
        severity: 'info',
        category: 'tests',
        message: `No tests reference ${contract.node.title}.`,
        nodeId: contract.node.id,
      });
    }
    for (const fn of contract.functions) {
      const data = fn.data as unknown as FunctionData | undefined;
      if (!data) continue;

      // `__constructor` runs once, at deploy, and cannot be called again.
      // There is no prior state to authorize against and no replay to guard, so
      // neither auth signal applies to it.
      if (fn.title === '__constructor') continue;

      if (!data.requiresAuth) {
        if (!mutatingFunctions.has(fn.id)) continue;
        // A one-shot initializer guarded by `has()` + panic is the canonical
        // Soroban pattern: at deploy time there is no admin to authorize, and
        // the guard is what makes replay impossible.
        if (guardsOf(fn.id).length > 0) continue;
        out.push({
          severity: 'warn',
          category: 'auth',
          message: `${contract.node.title}.${fn.title} writes state but never calls require_auth.`,
          nodeId: fn.id,
        });
        continue;
      }

      if (isUnguardedInitializer(memory, fn, data)) {
        out.push({
          severity: 'warn',
          category: 'auth',
          message:
            `${contract.node.title}.${fn.title} authorizes only \`${data.authSubjects?.[0]?.expr}\`, ` +
            `a caller-supplied parameter, and writes instance storage it never read — ` +
            `anyone can call it and claim that role.`,
          nodeId: fn.id,
        });
      }
    }

  }

  // Blanket-mocked authorization is one observation about the project's testing
  // practice, not a separate defect per contract — so it is reported once. It is
  // also only meaningful for contracts that have a real gate to exercise: a
  // contract with no storage-backed auth has nothing for a test to prove.
  const ungated = arch.contracts.filter((contract) => {
    const hasRealGate = contract.functions.some((fn) =>
      ((fn.data as unknown as FunctionData | undefined)?.authSubjects ?? []).some(
        (s) => s.origin === 'storage',
      ),
    );
    if (!hasRealGate || contract.tests.length === 0) return false;
    return contract.tests.every(
      (t) => (t.data as unknown as TestData | undefined)?.mocksAllAuths,
    );
  });

  // Error discriminants that no longer match what is deployed. A client matching
  // on the integer will misreport failures, and nothing about the build breaks.
  for (const node of nodesOfKind(memory, 'error')) {
    const data = node.data as unknown as ErrorData | undefined;
    if (data?.deployedMismatch) {
      out.push({
        severity: 'warn',
        category: 'abi',
        message: `${node.title} discriminants disagree with the deployed contract: ${data.deployedMismatch}.`,
        nodeId: node.id,
      });
    }
  }

  // Where the project moves value. Report what was observed and nothing more:
  // seeing `clawback` named in a source file does not establish that this
  // contract holds the asset's admin key.
  for (const node of nodesOfKind(memory, 'asset')) {
    const data = node.data as unknown as AssetData | undefined;
    if (!data) continue;
    const admin = data.methods.filter((m) =>
      ['mint', 'clawback', 'set_admin', 'set_authorized', 'burn_from'].includes(m),
    );
    if (data.kind === 'stellar-asset' && admin.length > 0) {
      out.push({
        severity: 'warn',
        category: 'value',
        message:
          `${node.title} is reached through a Stellar Asset Contract client and this project ` +
          `names ${admin.map((m) => `\`${m}\``).join(', ')} on it — administrative token operations.`,
        nodeId: node.id,
      });
    }
    // A caller-supplied token address is not a defect on its own — a generic
    // transfer helper takes one by design. It is recorded on the asset's note,
    // where a reader has the surrounding context, rather than raised as a
    // project-level warning that would fire on ordinary code.
  }

  if (ungated.length > 0) {
    const names = ungated.map((c) => c.node.title).join(', ');
    out.push({
      severity: 'warn',
      category: 'tests',
      message:
        `Every test module calls mock_all_auths, which disables authorization in the test ` +
        `environment. The access control on ${names} is therefore never exercised by the suite.`,
      // One observation about the project's testing practice. It used to carry
      // the first contract's id, which drew a warning ring on that contract
      // alone — so the picture said one contract while the sentence said three.
      scope: 'project',
    });
  }

  return out;
}

/** How a function's authorization reads in the digest an agent is given. */
export function describeAuth(data: FunctionData | undefined): string {
  if (!data?.requiresAuth) return '';
  const subjects = data.authSubjects ?? [];
  if (subjects.length === 0) return ' [requires auth, subject unresolved]';
  const described = subjects.map((s) => {
    switch (s.origin) {
      case 'storage':
        return `auth: ${s.expr} from ${s.key}`;
      case 'param':
        return `auth: ${s.expr} (caller-supplied parameter — restricts nobody)`;
      case 'current_contract':
        return 'auth: this contract';
      case 'guard-macro':
        return `auth: gated by ${s.expr}`;
      default:
        return `auth: ${s.expr} (origin unresolved)`;
    }
  });
  return ` [${described.join('; ')}]`;
}

/**
 * The one auth shape worth warning about.
 *
 * Deliberately narrow. `from.require_auth()` inside a SEP-41 `transfer` is a
 * caller-supplied parameter and is entirely correct — firing there would repeat
 * the mistake of judging a function by its shape rather than its effect. This
 * fires only on the conjunction that actually indicates a takeover: every auth
 * subject is caller-supplied, the function writes an instance-storage key it
 * never read, and there is no `has()` guard against re-initialization.
 */
function isUnguardedInitializer(
  memory: ProjectMemory,
  fn: MemoryNode,
  data: FunctionData,
): boolean {
  const subjects = data.authSubjects ?? [];
  if (subjects.length === 0) return false;
  if (!subjects.every((s) => s.origin === 'param')) return false;

  const byId = new Map(memory.nodes.map((n) => [n.id, n]));
  const durabilityOf = (id: string) =>
    (byId.get(id)?.data as unknown as StorageData | undefined)?.durability;

  const outgoing = memory.edges.filter((e) => e.from === fn.id);
  const writes = outgoing.filter((e) => e.kind === 'writes' && durabilityOf(e.to) === 'instance');
  if (writes.length === 0) return false;

  // Any read of instance storage means the function consulted existing state
  // before acting, and that read is the gate. This covers the `has()` re-init
  // guard and also the two-step ownership transfer, where `accept_admin`
  // authorizes a caller-supplied address and then checks it against the stored
  // pending admin — correct code that an earlier per-key comparison flagged.
  const readsInstance = outgoing.some(
    (e) => e.kind === 'reads' && durabilityOf(e.to) === 'instance',
  );
  return !readsInstance;
}

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

export interface ResumeReport {
  project: string;
  purpose?: string;
  lastScan?: string;
  lastScanAge?: string;
  /**
   * The window `changedSinceLastScan` actually covers. Reporting one scan's
   * timestamp next to another scan's change list read as a matched pair and was
   * not one — "what did I miss" answered confidently and wrongly.
   */
  changeWindow?: { from?: string; to: string; scanCount: number };
  /** True when there is no earlier scan to diff against, so "changed" means "first seen". */
  firstScan: boolean;
  contracts: { title: string; functions: number; deployedOn: string[] }[];
  /** Every live contract this project is wired to, including external ones. */
  deployments: { alias?: string; network: string; contractId: string; drift: DriftState; linked: boolean }[];
  changedSinceLastScan: MemoryNode[];
  openTasks: MemoryNode[];
  signals: Signal[];
  entryPoints: string[];
}

export function resumeReport(memory: ProjectMemory, nowIso: string): ResumeReport {
  const scans = memory.scans;
  const last = scans[scans.length - 1];
  const previous = scans[scans.length - 2];

  const byId = new Map(memory.nodes.map((n) => [n.id, n]));
  // Report what changed in the most recent scan, which is what the developer
  // missed while away.
  const changedIds = last?.changed ?? [];
  const changed = changedIds
    .filter((id) => !id.startsWith('removed:'))
    .map((id) => byId.get(id))
    .filter((n): n is MemoryNode => !!n)
    // Structural nodes tell the story; individual storage keys are noise here.
    .filter((n) => ['contract', 'function', 'deployment', 'task', 'doc', 'crate'].includes(n.kind))
    .slice(0, 25);

  const arch = architecture(memory);

  return {
    project: memory.project.name,
    purpose: memory.project.purpose,
    lastScan: previous?.at ?? last?.at,
    lastScanAge: previous ? humanAge(previous.at, nowIso) : undefined,
    // `changed` comes from the most recent scan, so the window it covers runs
    // from the scan before it to that one.
    changeWindow: last ? { from: previous?.at, to: last.at, scanCount: scans.length } : undefined,
    firstScan: scans.length < 2,
    contracts: arch.contracts.map((c) => ({
      title: c.node.title,
      functions: c.functions.length,
      deployedOn: c.deployments.map(
        (d) => (d.data as unknown as DeploymentData | undefined)?.network ?? 'unknown',
      ),
    })),
    // A deployment with no `deployed_as` edge is a contract the project talks to
    // but does not build — a token, an oracle, someone else's protocol. Those
    // are exactly the dependencies a returning developer forgets.
    deployments: nodesOfKind(memory, 'deployment').map((node) => {
      const data = node.data as unknown as DeploymentData | undefined;
      const linked = memory.edges.some((e) => e.kind === 'deployed_as' && e.to === node.id);
      return {
        alias: data?.alias,
        network: data?.network ?? 'unknown',
        contractId: data?.contractId ?? 'unknown',
        drift: driftState(data?.drift),
        linked,
      };
    }),
    changedSinceLastScan: changed,
    openTasks: nodesOfKind(memory, 'task').slice(0, 20),
    signals: signals(memory),
    entryPoints: arch.entryPoints,
  };
}

/* ------------------------------------------------------------------ *
 * Context for the AI layer
 * ------------------------------------------------------------------ */

/**
 * A compact, factual digest of the project, used as grounding for AI answers and
 * as the payload for the MCP `project_overview` tool. Kept small enough to sit
 * comfortably in a prompt.
 */
export function contextDigest(memory: ProjectMemory, maxChars = 12_000): string {
  const lines: string[] = [];
  const arch = architecture(memory);

  lines.push(`# Project: ${memory.project.name}`);
  if (memory.project.purpose) lines.push(`Purpose: ${memory.project.purpose}`);
  lines.push('');

  lines.push('## Contracts');
  for (const c of arch.contracts) {
    lines.push(`### ${c.node.title}${c.crate ? ` (crate: ${c.crate})` : ''}`);
    if (c.node.path) lines.push(`Source: ${c.node.path}`);
    const cd = c.node.data as unknown as ContractData | undefined;
    if (cd?.implementsTraits?.length) {
      lines.push(`Implements: ${cd.implementsTraits.join(', ')}`);
    }
    lines.push(
      cd?.upgradeable
        ? `Upgradeable: yes, via ${cd.upgradeFn ?? 'an upgrade function'} — live state written by older code must still decode.`
        : 'Upgradeable: no — a bug here cannot be patched in place.',
    );
    for (const fn of c.functions) {
      const d = fn.data as unknown as FunctionData | undefined;
      const params = (d?.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ');
      const ret = d?.returns ? ` -> ${d.returns}` : '';
      lines.push(`- ${fn.title}(${params})${ret}${describeAuth(d)}`);
    }
    if (c.calls.length) lines.push(`Calls: ${c.calls.map((n) => n.title).join(', ')}`);
    if (c.deployments.length) {
      for (const d of c.deployments) {
        const data = d.data as unknown as DeploymentData | undefined;
        lines.push(
          `Deployed on ${data?.network}: ${data?.contractId} (drift: ${DRIFT_LABEL[driftState(data?.drift)]})`,
        );
      }
    }
    if (c.tests.length) lines.push(`Tested by: ${c.tests.map((t) => t.path ?? t.title).join(', ')}`);
    lines.push('');
  }

  const storage = nodesOfKind(memory, 'storage');
  if (storage.length) {
    lines.push('## Storage keys');
    for (const s of storage.slice(0, 40)) {
      const d = s.data as unknown as StorageData | undefined;
      lines.push(`- ${d?.key} (${d?.durability}${d?.hasTtlExtension ? ', ttl extended' : ''})`);
    }
    lines.push('');
  }

  const tasks = nodesOfKind(memory, 'task');
  if (tasks.length) {
    lines.push('## Open tasks');
    for (const t of tasks.slice(0, 25)) lines.push(`- ${t.title} (${t.path}:${t.line})`);
    lines.push('');
  }

  const sig = signals(memory);
  if (sig.length) {
    lines.push('## Flagged');
    for (const s of sig) lines.push(`- [${s.severity}] ${s.message}`);
  }

  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}
