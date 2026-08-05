/**
 * Turns a node and its edges into the machine-owned half of a Markdown note.
 *
 * The rendering aims at something a human would actually read on returning to a
 * project: what this thing is, what it touches, and what it is connected to —
 * with links, so the vault is navigable rather than merely descriptive.
 */

import type {
  AssetData,
  ContractData,
  DeploymentData,
  ErrorData,
  FunctionData,
  MemoryEdge,
  MemoryNode,
  ProjectMemory,
  StorageData,
} from '../core/types.js';
import { wikilink } from './keys.js';

export interface RenderContext {
  byId: Map<string, MemoryNode>;
  outgoing: MemoryEdge[];
  incoming: MemoryEdge[];
  memory: ProjectMemory;
}

/** How each edge reads in prose, from the perspective of the node being rendered. */
const OUTGOING_LABEL: Record<MemoryEdge['kind'], string> = {
  defines: 'Defines',
  calls: 'Calls',
  depends_on: 'Depends on',
  tests: 'Tests',
  deploys: 'Deploys',
  deployed_as: 'Deployed as',
  reads: 'Reads',
  writes: 'Writes',
  emits: 'Emits',
  raises: 'Can fail with',
  documents: 'Documents',
  mentions: 'Mentions',
};

const INCOMING_LABEL: Record<MemoryEdge['kind'], string> = {
  defines: 'Defined in',
  calls: 'Called by',
  depends_on: 'Required by',
  tests: 'Tested by',
  deploys: 'Deployed by',
  deployed_as: 'Source contract',
  reads: 'Read by',
  writes: 'Written by',
  emits: 'Emitted by',
  raises: 'Raised by',
  documents: 'Documented in',
  mentions: 'Mentioned in',
};

export function renderFrontmatter(node: MemoryNode): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
    title: node.title,
  };
  if (node.path) fm.path = node.path;
  if (node.summary) fm.summary = node.summary;
  fm.first_seen = node.firstSeen;
  fm.last_changed = node.lastChanged;
  // Obsidian surfaces tags; kind-as-tag makes the graph view filterable.
  fm.tags = ['stellar-memory', `kind/${node.kind}`];
  return fm;
}

export function renderNoteBody(node: MemoryNode, ctx: RenderContext): string {
  const out: string[] = [];

  out.push(`# ${node.title}`);
  out.push('');

  if (node.summary) {
    out.push(node.summary);
    out.push('');
  }

  const where = renderLocation(node);
  if (where) {
    out.push(where);
    out.push('');
  }

  const detail = renderKindDetail(node, ctx);
  if (detail) {
    out.push(detail);
    out.push('');
  }

  const rels = renderRelationships(node, ctx);
  if (rels) {
    out.push(rels);
    out.push('');
  }

  const prov = renderProvenance(node);
  if (prov) out.push(prov);

  return out.join('\n').trimEnd();
}

function renderLocation(node: MemoryNode): string {
  if (!node.path) return '';
  const loc = node.line ? `${node.path}:${node.line}` : node.path;
  return `**Source:** \`${loc}\``;
}

function renderKindDetail(node: MemoryNode, ctx: RenderContext): string {
  switch (node.kind) {
    case 'contract':
      return renderContract(node, ctx);
    case 'function':
      return renderFunction(node);
    case 'storage':
      return renderStorage(node);
    case 'deployment':
      return renderDeployment(node);
    case 'error':
      return renderError(node);
    case 'asset':
      return renderAsset(node);
    case 'project':
      return renderProject(ctx.memory);
    default:
      return '';
  }
}

function renderContract(node: MemoryNode, ctx: RenderContext): string {
  const data = node.data as unknown as ContractData | undefined;
  if (!data) return '';
  const lines: string[] = ['## Interface', ''];

  const fns = ctx.outgoing
    .filter((e) => e.kind === 'defines')
    .map((e) => ctx.byId.get(e.to))
    .filter((n): n is MemoryNode => !!n && n.kind === 'function');

  if (fns.length === 0) {
    lines.push('_No public functions detected._');
  } else {
    for (const fn of fns) {
      const fd = fn.data as unknown as FunctionData | undefined;
      const params = (fd?.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ');
      const ret = fd?.returns ? ` -> ${fd.returns}` : '';
      const auth = fd?.requiresAuth ? '  🔒 requires auth' : '';
      lines.push(`- \`${fn.title}(${params})${ret}\`${auth} — ${wikilink(fn)}`);
    }
  }

  if (data.localWasmHash) {
    lines.push('');
    lines.push(`**Local Wasm hash:** \`${data.localWasmHash}\``);
  }
  return lines.join('\n');
}

function renderFunction(node: MemoryNode): string {
  const data = node.data as unknown as FunctionData | undefined;
  if (!data) return '';
  const lines: string[] = ['## Signature', '', '```rust'];
  const params = data.params.map((p) => `${p.name}: ${p.type}`).join(', ');
  lines.push(`fn ${node.title}(${params})${data.returns ? ` -> ${data.returns}` : ''}`);
  lines.push('```');

  if (data.requiresAuth) {
    lines.push('', '## Authorization', '');
    const subjects = data.authSubjects ?? [];
    if (subjects.length === 0) {
      lines.push('Calls `require_auth`, but the subject could not be resolved.');
    }
    for (const subject of subjects) {
      const call = subject.forArgs ? '`require_auth_for_args`' : '`require_auth`';
      switch (subject.origin) {
        case 'storage':
          lines.push(
            `- ${call} on \`${subject.expr}\`, loaded from \`${subject.key}\` — this restricts callers to the stored address.`,
          );
          break;
        case 'param':
          lines.push(
            `- ⚠️ ${call} on \`${subject.expr}\`, which is a **parameter supplied by the caller**. ` +
              `The caller proves control of an address they chose, so this does not restrict who may call it.`,
          );
          break;
        case 'current_contract':
          lines.push(`- ${call} on this contract's own address.`);
          break;
        case 'guard-macro':
          lines.push(
            `- Gated by \`${subject.expr}\`, a library attribute that performs the ` +
              `authorization check outside the function body.`,
          );
          break;
        default:
          lines.push(`- ${call} on \`${subject.expr}\` — origin not resolved.`);
      }
    }
  }
  return lines.join('\n');
}

function renderStorage(node: MemoryNode): string {
  const data = node.data as unknown as StorageData | undefined;
  if (!data) return '';
  const lines = [
    '## Storage',
    '',
    `- **Durability:** \`${data.durability}\``,
    `- **Key:** \`${data.key}\``,
  ];
  if (data.durability !== 'temporary' && !data.hasTtlExtension) {
    lines.push(
      `- ⚠️ No \`extend_ttl\` call was found for this key. ${data.durability} entries expire once their TTL lapses, and the data becomes unreachable.`,
    );
  }
  return lines.join('\n');
}

function renderDeployment(node: MemoryNode): string {
  const data = node.data as unknown as DeploymentData | undefined;
  if (!data) return '';
  const lines = [
    '## On-chain',
    '',
    `- **Network:** \`${data.network}\``,
    `- **Contract ID:** \`${data.contractId}\``,
  ];
  if (data.alias) lines.push(`- **Alias:** \`${data.alias}\``);
  if (data.onChainWasmHash) lines.push(`- **Deployed Wasm hash:** \`${data.onChainWasmHash}\``);
  if (data.drift === 'stale') {
    lines.push(
      '- ⚠️ **Drift:** the Wasm deployed here does not match your local build. What runs on this network is older than your source.',
    );
  } else if (data.drift === 'in-sync') {
    lines.push('- ✅ **Drift:** deployed Wasm matches the local build.');
  }
  if (data.meta && Object.keys(data.meta).length > 0) {
    lines.push('', '### Build metadata', '');
    for (const [k, v] of Object.entries(data.meta)) lines.push(`- \`${k}\`: ${v}`);
  }
  return lines.join('\n');
}

function renderError(node: MemoryNode): string {
  const data = node.data as unknown as ErrorData | undefined;
  if (!data?.variants?.length) return '';
  const lines = [
    '## Variants',
    '',
    'These discriminants are published ABI. A client matches on the integer, and a',
    'failed invocation reaches the caller as `Error(Contract, #N)` — so renumbering',
    'an existing variant breaks integrations without breaking the build.',
    '',
    '| Variant | Code |',
    '|---|---:|',
  ];
  for (const v of [...data.variants].sort((a, b) => a.code - b.code)) {
    lines.push(`| \`${v.name}\` | ${v.code} |`);
  }
  if (data.deployedMismatch) {
    lines.push('', `> ⚠️ **Disagrees with the deployed contract:** ${data.deployedMismatch}`);
  }
  return lines.join('\n');
}

function renderAsset(node: MemoryNode): string {
  const data = node.data as unknown as AssetData | undefined;
  if (!data) return '';
  const lines = ['## Value path', ''];

  lines.push(
    data.kind === 'stellar-asset'
      ? '- Reached through a **Stellar Asset Contract client**, the administrative interface of an asset.'
      : '- Reached through a **token client**.',
  );

  lines.push(
    data.addressOrigin === 'storage'
      ? `- Address is configured, read from \`${data.addressKey}\`.`
      : data.addressOrigin === 'param'
        ? '- ⚠️ Address is **supplied by the caller**, not read from storage — callers choose which contract this talks to.'
        : '- Address origin could not be resolved.',
  );

  if (data.methods.length > 0) {
    lines.push('', `**Methods this project calls:** ${data.methods.map((m) => `\`${m}\``).join(', ')}`);
  }
  return lines.join('\n');
}

function renderProject(memory: ProjectMemory): string {
  const counts = new Map<string, number>();
  for (const n of memory.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const lines = ['## Inventory', ''];
  for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (kind === 'project') continue;
    lines.push(`- ${count} ${kind}${count === 1 ? '' : 's'}`);
  }
  if (memory.project.networks.length > 0) {
    // These are the networks the last scan looked at, which comes from the
    // `--network` flag. It is not a discovered property of the project, and
    // must not be presented as one.
    lines.push('', `**Networks checked by the last scan:** ${memory.project.networks.join(', ')}`);
  }
  return lines.join('\n');
}

function renderRelationships(node: MemoryNode, ctx: RenderContext): string {
  const groups = new Map<string, string[]>();

  const add = (label: string, entry: string) => {
    if (!groups.has(label)) groups.set(label, []);
    const list = groups.get(label)!;
    if (!list.includes(entry)) list.push(entry);
  };

  for (const edge of ctx.outgoing) {
    // `defines` on a contract is already covered by the Interface section.
    if (node.kind === 'contract' && edge.kind === 'defines') continue;
    const target = ctx.byId.get(edge.to);
    if (!target) continue;
    add(OUTGOING_LABEL[edge.kind], `${wikilink(target)}${edge.note ? ` — ${edge.note}` : ''}`);
  }

  for (const edge of ctx.incoming) {
    const source = ctx.byId.get(edge.from);
    if (!source) continue;
    add(INCOMING_LABEL[edge.kind], `${wikilink(source)}${edge.note ? ` — ${edge.note}` : ''}`);
  }

  if (groups.size === 0) return '';

  const lines = ['## Connections', ''];
  for (const [label, entries] of groups) {
    lines.push(`**${label}**`);
    for (const e of entries) lines.push(`- ${e}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderProvenance(node: MemoryNode): string {
  if (node.provenance.length === 0) return '';
  const lines = ['---', '', '<details><summary>Where this came from</summary>', ''];
  for (const p of node.provenance) {
    switch (p.source) {
      case 'source':
        lines.push(`- Parsed from \`${p.file}${p.line ? `:${p.line}` : ''}\``);
        break;
      case 'config':
        lines.push(`- Read from \`${p.file}\``);
        break;
      case 'stellar-cli':
        lines.push(
          `- Reported by \`${p.command}\`${p.network ? ` on \`${p.network}\`` : ''} (ground truth)`,
        );
        break;
      case 'git':
        lines.push(`- From git \`${p.ref}\``);
        break;
      case 'human':
        lines.push(`- Written by hand in \`${p.file}\``);
        break;
      case 'ai':
        lines.push(`- Generated by \`${p.model}\` — inferred, not verified`);
        break;
    }
  }
  lines.push('', '</details>');
  return lines.join('\n');
}
