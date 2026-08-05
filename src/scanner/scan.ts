/**
 * The scan: turn a working tree into a ProjectMemory.
 *
 * Order matters. Source analysis comes first and always succeeds; on-chain
 * enrichment comes second and is allowed to fail. A developer on a plane gets a
 * complete structural memory, and the same command run online adds the half that
 * only the network can answer.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  AssetData,
  ContractData,
  DeploymentData,
  ErrorData,
  FunctionData,
  MemoryEdge,
  MemoryNode,
  ProjectMemory,
  Provenance,
  StorageData,
  TestData,
} from '../core/types.js';
import { readGitInfo, type GitInfo } from '../core/git.js';
import { readFileSafe, walkRepo, type FileEntry } from './walk.js';
import { analyseRustFile, type RustFileAnalysis } from './rust.js';
import {
  isContractCrate,
  legacyWasmArtifactPath,
  parseCargoToml,
  wasmArtifactPath,
  type CrateManifest,
} from './cargo.js';
import {
  describeCommand,
  fetchInterface,
  fetchWasmHash,
  fetchMeta,
  listAliases,
  stellarVersion,
  type AliasEntry,
} from '../stellar/cli.js';
import { docSummary, formatSignature } from '../stellar/spec.js';

export interface ScanOptions {
  root: string;
  /** ISO timestamp used for firstSeen/lastChanged, injected for testability. */
  now: string;
  /** When false, no network or CLI calls are made at all. */
  online: boolean;
  /** Networks to look for deployments on. Defaults to testnet and mainnet. */
  networks?: string[];
  previous?: ProjectMemory | null;
  onProgress?: (message: string) => void;
}

export interface ScanOutcome {
  memory: ProjectMemory;
  stats: {
    filesSeen: number;
    rustFiles: number;
    contracts: number;
    deployments: number;
    /** Non-fatal problems worth telling the user about. */
    warnings: string[];
  };
}

export async function scanProject(options: ScanOptions): Promise<ScanOutcome> {
  const { root, now } = options;
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  const nodes = new Map<string, MemoryNode>();
  const edges: MemoryEdge[] = [];

  const addNode = (node: Omit<MemoryNode, 'firstSeen' | 'lastChanged'>) => {
    const existing = nodes.get(node.id);
    if (existing) {
      // Merge provenance rather than letting the last writer win.
      existing.provenance.push(...node.provenance);
      if (!existing.summary && node.summary) existing.summary = node.summary;
      if (node.data) existing.data = { ...(existing.data ?? {}), ...node.data };
      return existing;
    }
    const full: MemoryNode = { ...node, firstSeen: now, lastChanged: now };
    nodes.set(node.id, full);
    return full;
  };

  const addEdge = (edge: MemoryEdge) => {
    const dup = edges.some(
      (e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
    );
    if (!dup) edges.push(edge);
  };

  /* ---------------------------------------------------------------- *
   * 1. Walk
   * ---------------------------------------------------------------- */
  progress('Reading the working tree');
  const { files } = await walkRepo(root);

  const rustFiles = files.filter((f) => f.ext === '.rs');
  const cargoFiles = files.filter((f) => f.rel.endsWith('Cargo.toml'));
  const markdownFiles = files.filter((f) => f.ext === '.md');

  /* ---------------------------------------------------------------- *
   * 2. Crates
   * ---------------------------------------------------------------- */
  progress(`Reading ${cargoFiles.length} Cargo manifest${cargoFiles.length === 1 ? '' : 's'}`);
  const manifests: CrateManifest[] = [];
  for (const file of cargoFiles) {
    const source = await readFileSafe(file);
    if (!source) continue;
    const manifest = parseCargoToml(file.rel, source);
    if (!manifest) {
      warnings.push(`Could not parse ${file.rel}; skipped.`);
      continue;
    }
    manifests.push(manifest);
    if (!manifest.name) continue; // a workspace root without its own package

    const prov: Provenance[] = [{ source: 'config', file: file.rel }];
    addNode({
      id: `crate:${manifest.name}`,
      kind: 'crate',
      title: manifest.name,
      path: file.rel,
      summary:
        manifest.description ??
        (isContractCrate(manifest)
          ? 'Soroban contract crate.'
          : 'Rust crate in this workspace.'),
      data: {
        version: manifest.version,
        isContract: isContractCrate(manifest),
        sorobanSdkVersion: manifest.sorobanSdkVersion,
        dependencies: manifest.dependencies,
      },
      provenance: prov,
    });
  }

  const crateNames = new Set(manifests.map((m) => m.name).filter((n): n is string => !!n));
  for (const manifest of manifests) {
    if (!manifest.name) continue;
    for (const dep of manifest.dependencies) {
      if (!crateNames.has(dep)) continue; // only intra-workspace edges are meaningful here
      addEdge({
        from: `crate:${manifest.name}`,
        to: `crate:${dep}`,
        kind: 'depends_on',
        provenance: [{ source: 'config', file: manifest.rel }],
      });
    }
  }

  /** Map a file path to the crate whose directory best contains it. */
  const crateForPath = (rel: string): CrateManifest | undefined => {
    let best: CrateManifest | undefined;
    for (const m of manifests) {
      if (!m.name) continue;
      const prefix = m.dir === '.' ? '' : `${m.dir}/`;
      if (rel.startsWith(prefix) && (!best || m.dir.length > best.dir.length)) best = m;
    }
    return best;
  };

  /* ---------------------------------------------------------------- *
   * 3. Rust source
   * ---------------------------------------------------------------- */
  progress(`Analysing ${rustFiles.length} Rust file${rustFiles.length === 1 ? '' : 's'}`);
  const analyses: RustFileAnalysis[] = [];
  /** contract name -> the crate it belongs to, for later Wasm lookup. */
  const contractCrate = new Map<string, string>();
  /** module name used in `contractimport!` -> importing contract. */
  const importsByFile = new Map<string, RustFileAnalysis>();

  for (const file of rustFiles) {
    const source = await readFileSafe(file);
    if (!source) continue;
    const analysis = analyseRustFile(file.rel, source);
    analyses.push(analysis);
    importsByFile.set(file.rel, analysis);

    const crate = crateForPath(file.rel);
    const fileProv: Provenance[] = [{ source: 'source', file: file.rel }];

    if (analysis.isTest && analysis.contracts.length === 0) {
      addNode({
        id: `test:${file.rel}`,
        kind: 'test',
        title: shortLabel(file.rel),
        path: file.rel,
        summary: 'Test module.',
        provenance: fileProv,
      });
      continue;
    }

    if (analysis.contracts.length === 0 && analysis.types.length === 0 && analysis.errors.length === 0) {
      // A plain module. Record it only when it belongs to a contract crate, so
      // that non-Stellar repos do not drown the graph in noise.
      if (crate && isContractCrate(crate)) {
        addNode({
          id: `module:${file.rel}`,
          kind: 'module',
          title: shortLabel(file.rel),
          path: file.rel,
          provenance: fileProv,
        });
      }
      continue;
    }

    for (const contract of analysis.contracts) {
      const contractId = `contract:${contract.name}`;
      const data: ContractData = {
        crate: crate?.name ?? 'unknown',
        functions: contract.functions.map((f) => f.name),
        implementsTraits: contract.implementsTraits,
        upgradeable: contract.upgradeable,
        upgradeFn: contract.upgradeFn,
      };
      addNode({
        id: contractId,
        kind: 'contract',
        title: contract.name,
        path: file.rel,
        line: contract.line,
        summary: `Soroban contract with ${contract.functions.length} public function${contract.functions.length === 1 ? '' : 's'}.`,
        data: data as unknown as Record<string, unknown>,
        provenance: [{ source: 'source', file: file.rel, line: contract.line }],
      });
      if (crate?.name) {
        contractCrate.set(contract.name, crate.name);
        addEdge({
          from: `crate:${crate.name}`,
          to: contractId,
          kind: 'defines',
          provenance: [{ source: 'config', file: crate.rel }],
        });
      }

      for (const fn of contract.functions) {
        const fnId = `function:${contract.name}.${fn.name}`;
        const fnData: FunctionData = {
          params: fn.params,
          returns: fn.returns,
          requiresAuth: fn.requiresAuth,
          authSubjects: fn.authSubjects.length > 0 ? fn.authSubjects : undefined,
          visibility: 'public',
        };
        addNode({
          id: fnId,
          kind: 'function',
          title: fn.name,
          path: file.rel,
          line: fn.line,
          data: fnData as unknown as Record<string, unknown>,
          provenance: [{ source: 'source', file: file.rel, line: fn.line }],
        });
        addEdge({
          from: contractId,
          to: fnId,
          kind: 'defines',
          provenance: [{ source: 'source', file: file.rel, line: fn.line }],
        });

        for (const access of fn.storage) {
          // A keyless access addresses no single entry — an instance-wide TTL
          // extension, or a key computed at runtime. Inventing a node called
          // `(dynamic)` or `100` for it would put noise in the graph and, worse,
          // present it to an agent as a real storage key.
          if (!access.key) continue;
          const key = access.key;
          const storageId = `storage:${contract.name}.${access.durability}.${key}`;
          const existing = nodes.get(storageId)?.data as unknown as StorageData | undefined;
          const storageData: StorageData = {
            durability: access.durability,
            key,
            hasTtlExtension: existing?.hasTtlExtension || access.op === 'extend_ttl',
          };
          addNode({
            id: storageId,
            kind: 'storage',
            title: `${key} (${access.durability})`,
            path: file.rel,
            line: access.line,
            data: storageData as unknown as Record<string, unknown>,
            provenance: [{ source: 'source', file: file.rel, line: access.line }],
          });
          // Re-apply, because addNode merges rather than replaces.
          const node = nodes.get(storageId)!;
          (node.data as unknown as StorageData).hasTtlExtension = storageData.hasTtlExtension;

          const kind = access.op === 'get' || access.op === 'try_get' || access.op === 'has'
            ? 'reads'
            : 'writes';
          addEdge({
            from: fnId,
            to: storageId,
            kind,
            note: `\`${access.op}\``,
            provenance: [{ source: 'source', file: file.rel, line: access.line }],
          });
        }

        // `raises`: the declared failure modes of this entry point. The return
        // type names the error enum, so the edge is a literal match.
        for (const error of analysis.errors) {
          if (!fn.returns?.includes(error.name)) continue;
          addEdge({
            from: fnId,
            to: `error:${error.name}`,
            kind: 'raises',
            provenance: [{ source: 'source', file: file.rel, line: fn.line }],
          });
        }

        // Token and SAC clients come from the SDK, not from a workspace crate,
        // so they never resolved to a contract node and were dropped — leaving
        // no trace of where a project moves value.
        for (const call of fn.contractCalls) {
          if (call.kind === 'generated') continue;
          const assetId = `asset:${call.client}.${call.addressKey ?? call.address ?? 'unknown'}`;
          const assetData: AssetData = {
            kind: call.kind,
            addressOrigin: call.addressOrigin,
            addressKey: call.addressKey,
            methods: call.methods,
          };
          const existing = nodes.get(assetId)?.data as unknown as AssetData | undefined;
          if (existing) {
            assetData.methods = [...new Set([...existing.methods, ...call.methods])];
          }
          addNode({
            id: assetId,
            kind: 'asset',
            title:
              call.addressOrigin === 'storage'
                ? `${call.client} at ${call.addressKey}`
                : `${call.client} (${call.address ?? 'address unresolved'})`,
            path: file.rel,
            line: fn.line,
            summary:
              call.kind === 'stellar-asset'
                ? 'Stellar Asset Contract client — the administrative interface of an asset.'
                : 'Token contract this project moves value through.',
            data: assetData as unknown as Record<string, unknown>,
            provenance: [{ source: 'source', file: file.rel, line: fn.line }],
          });
          // Re-apply after the merge in addNode.
          (nodes.get(assetId)!.data as unknown as AssetData).methods = assetData.methods;

          addEdge({
            from: fnId,
            to: assetId,
            kind: 'calls',
            note: call.methods.length ? `calls \`${call.methods.join('`, `')}\`` : undefined,
            provenance: [{ source: 'source', file: file.rel, line: fn.line }],
          });
        }

        for (const topic of fn.events) {
          const eventId = `event:${contract.name}.${topic}`;
          addNode({
            id: eventId,
            kind: 'event',
            title: topic,
            path: file.rel,
            line: fn.line,
            summary: 'Published via `env.events().publish(...)`.',
            provenance: [{ source: 'source', file: file.rel, line: fn.line }],
          });
          addEdge({
            from: fnId,
            to: eventId,
            kind: 'emits',
            provenance: [{ source: 'source', file: file.rel, line: fn.line }],
          });
        }
      }
    }

    for (const t of analysis.types) {
      addNode({
        id: `type:${t.name}`,
        kind: 'type',
        title: t.name,
        path: file.rel,
        line: t.line,
        summary: 'Contract type (`#[contracttype]`).',
        provenance: [{ source: 'source', file: file.rel, line: t.line }],
      });
    }
    for (const e of analysis.errors) {
      const errorData: ErrorData = { variants: e.variants };
      addNode({
        id: `error:${e.name}`,
        kind: 'error',
        title: e.name,
        path: file.rel,
        line: e.line,
        summary:
          e.variants.length > 0
            ? `Contract error enum with ${e.variants.length} variant${e.variants.length === 1 ? '' : 's'}. The discriminants are published ABI.`
            : 'Contract error enum (`#[contracterror]`).',
        data: errorData as unknown as Record<string, unknown>,
        provenance: [{ source: 'source', file: file.rel, line: e.line }],
      });
    }
    for (const e of analysis.events) {
      addNode({
        id: `event:${e.name}`,
        kind: 'event',
        title: e.name,
        path: file.rel,
        line: e.line,
        summary: 'Declared event (`#[contractevent]`).',
        provenance: [{ source: 'source', file: file.rel, line: e.line }],
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * 4. Cross-contract calls
   * ---------------------------------------------------------------- */
  linkCrossContractCalls(analyses, nodes, addEdge, contractCrate);

  /* ---------------------------------------------------------------- *
   * 5. Tests, docs, scripts, tasks
   * ---------------------------------------------------------------- */
  progress('Indexing docs, scripts and open tasks');
  await indexTests(root, files, nodes, addNode, addEdge);
  const purpose = await indexDocs(root, markdownFiles, addNode, addEdge, nodes);
  indexScripts(files, addNode);
  await indexTasks(root, files, addNode, addEdge, nodes);

  /* ---------------------------------------------------------------- *
   * 6. On-chain
   * ---------------------------------------------------------------- */
  const networks = options.networks ?? ['testnet', 'mainnet'];
  let deploymentCount = 0;
  if (options.online) {
    const version = await stellarVersion();
    if (!version) {
      warnings.push('The `stellar` CLI was not found on PATH, so no on-chain data was collected.');
    } else {
      progress(`Checking deployments via ${version}`);
      deploymentCount = await enrichOnChain({
        root,
        networks,
        nodes,
        addNode,
        addEdge,
        contractCrate,
        warnings,
        progress,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * 7. Project node and bookkeeping
   * ---------------------------------------------------------------- */
  const git = await readGitInfo(root);
  const projectName = path.basename(path.resolve(root));
  const contracts = [...nodes.values()].filter((n) => n.kind === 'contract');

  addNode({
    id: `project:${projectName}`,
    kind: 'project',
    title: projectName,
    summary: purpose,
    data: {
      branch: git.branch,
      head: git.head,
      lastCommitDate: git.lastCommitDate,
      dirtyFiles: git.dirty.length,
    },
    provenance: git.isRepo ? [{ source: 'git', ref: git.head ?? 'HEAD' }] : [],
  });
  for (const contract of contracts) {
    addEdge({
      from: `project:${projectName}`,
      to: contract.id,
      kind: 'defines',
      provenance: [],
    });
  }

  const memory: ProjectMemory = {
    version: 1,
    project: {
      name: projectName,
      root,
      purpose,
      networks: networks.slice(),
    },
    nodes: [...nodes.values()],
    edges,
    scans: [...(options.previous?.scans ?? [])],
  };

  const changed = reconcileWithPrevious(memory, options.previous ?? null, now);
  memory.scans.push({
    at: now,
    commit: git.head,
    nodeCount: memory.nodes.length,
    edgeCount: memory.edges.length,
    changed,
  });
  // Keep the history bounded; the last 50 scans are more than enough context.
  if (memory.scans.length > 50) memory.scans = memory.scans.slice(-50);

  return {
    memory,
    stats: {
      filesSeen: files.length,
      rustFiles: rustFiles.length,
      contracts: contracts.length,
      deployments: deploymentCount,
      warnings,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type AddNode = (node: Omit<MemoryNode, 'firstSeen' | 'lastChanged'>) => MemoryNode;
type AddEdge = (edge: MemoryEdge) => void;

/** Lowercase and drop separators, so `employee_registry` == `EmployeeRegistry`. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve `contractimport!` modules and generated clients to real contract nodes.
 * This is what turns a pile of crates into an architecture diagram.
 *
 * Resolution goes through three routes because Soroban projects name the same
 * contract three ways: the Rust type (`EmployeeRegistry`), the crate
 * (`employee-registry`), and the module wrapping the import (`registry`). The
 * module name alone is often unrelated to the contract, so the imported Wasm
 * filename is the reliable link back to the crate that produced it.
 */
function linkCrossContractCalls(
  analyses: RustFileAnalysis[],
  nodes: Map<string, MemoryNode>,
  addEdge: AddEdge,
  contractCrate: Map<string, string>,
): void {
  const byName = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== 'contract') continue;
    byName.set(normaliseName(node.title), node.id);
    const crate = contractCrate.get(node.title);
    if (crate) byName.set(normaliseName(crate), node.id);
  }

  const lookup = (name: string): string | undefined => {
    const norm = normaliseName(name);
    return (
      byName.get(norm) ??
      byName.get(norm.replace(/(contract|client)$/, '')) ??
      byName.get(`${norm}contract`)
    );
  };

  for (const analysis of analyses) {
    // Within this file, which Wasm does each `mod` bring in?
    const wasmByModule = new Map<string, string>();
    for (const imp of analysis.imports) {
      if (imp.module && imp.wasmFile) wasmByModule.set(imp.module, imp.wasmFile);
    }

    /** Try the name itself, then the Wasm artifact the module imported. */
    const resolve = (name: string): string | undefined => {
      const direct = lookup(name);
      if (direct) return direct;
      const wasm = wasmByModule.get(name);
      if (!wasm) return undefined;
      const artifact = wasm.split('/').pop()?.replace(/\.wasm$/i, '');
      return artifact ? lookup(artifact) : undefined;
    };

    for (const contract of analysis.contracts) {
      const fromId = `contract:${contract.name}`;
      if (!nodes.has(fromId)) continue;

      for (const fn of contract.functions) {
        for (const client of fn.clientCalls) {
          const target = resolve(client);
          if (!target || target === fromId) continue;
          addEdge({
            from: fromId,
            to: target,
            kind: 'calls',
            note: `via \`${client}::Client\` in \`${fn.name}\``,
            provenance: [{ source: 'source', file: analysis.rel, line: fn.line }],
          });
        }
      }
    }

    // An import without a matching client call is still a declared dependency.
    for (const imp of analysis.imports) {
      const target = resolve(imp.module ?? '') ?? resolveWasm(imp.wasmFile, lookup);
      if (!target) continue;
      for (const contract of analysis.contracts) {
        const fromId = `contract:${contract.name}`;
        if (!nodes.has(fromId) || fromId === target) continue;
        addEdge({
          from: fromId,
          to: target,
          kind: 'calls',
          note: `imports \`${imp.wasmFile ?? imp.module}\``,
          provenance: [{ source: 'source', file: analysis.rel, line: imp.line }],
        });
      }
    }
  }
}

function resolveWasm(
  wasmFile: string | undefined,
  lookup: (name: string) => string | undefined,
): string | undefined {
  if (!wasmFile) return undefined;
  const artifact = wasmFile.split('/').pop()?.replace(/\.wasm$/i, '');
  return artifact ? lookup(artifact) : undefined;
}

async function indexTests(
  root: string,
  files: FileEntry[],
  nodes: Map<string, MemoryNode>,
  addNode: AddNode,
  addEdge: AddEdge,
): Promise<void> {
  const contractTitles = [...nodes.values()].filter((n) => n.kind === 'contract');
  const testFiles = files.filter(
    (f) => f.ext === '.rs' && (/(^|\/)tests?\//.test(f.rel) || /_?tests?\.rs$/.test(f.rel)),
  );

  for (const file of testFiles) {
    const id = `test:${file.rel}`;
    const source = await readFileSafe(file);

    // `mock_all_auths` disables every authorization check in the test env. It is
    // the right tool for testing business logic and the wrong one for proving a
    // contract is access-controlled.
    //
    // But a real suite mixes both in one file: a blanket-mocked happy path plus
    // targeted `mock_auths` / `set_auths(&[])` rejection tests. Treating any
    // occurrence as tainting the whole module told developers to write tests
    // they had already written, so a module that also exercises auth directly
    // does not count as blanket-mocked.
    const blanketMocks = source ? /\bmock_all_auths(_allowing_non_root_auth)?\s*\(/.test(source) : false;
    const exercisesAuth = source
      ? /\b(mock_auths|set_auths|try_[a-z_]+\s*\([^)]*\)[\s\S]{0,200}?(Unauthorized|InvalidAction))/.test(source)
      : false;
    const mocksAllAuths = blanketMocks && !exercisesAuth;
    const testCount = source ? (source.match(/#\[test\]/g) ?? []).length : 0;
    const testData: TestData = { mocksAllAuths, testCount };

    addNode({
      id,
      kind: 'test',
      title: shortLabel(file.rel),
      path: file.rel,
      summary: testCount > 0 ? `${testCount} test${testCount === 1 ? '' : 's'}.` : 'Test module.',
      data: testData as unknown as Record<string, unknown>,
      provenance: [{ source: 'source', file: file.rel }],
    });

    if (!source) continue;
    for (const contract of contractTitles) {
      // A test that names a contract almost certainly exercises it.
      const re = new RegExp(`\\b${escapeRegex(contract.title)}(Client)?\\b`);
      if (re.test(source)) {
        addEdge({
          from: id,
          to: contract.id,
          kind: 'tests',
          provenance: [{ source: 'source', file: file.rel }],
        });
      }
    }
  }
}

async function indexDocs(
  root: string,
  markdownFiles: FileEntry[],
  addNode: AddNode,
  addEdge: AddEdge,
  nodes: Map<string, MemoryNode>,
): Promise<string | undefined> {
  let purpose: string | undefined;

  for (const file of markdownFiles) {
    // The vault's own notes are not project documentation.
    if (file.rel.startsWith('.stellar-memory/')) continue;

    const source = await readFileSafe(file);
    if (!source) continue;

    const id = `doc:${file.rel}`;
    const summary = firstProse(source);
    addNode({
      id,
      kind: 'doc',
      title: path.basename(file.rel),
      path: file.rel,
      summary,
      provenance: [{ source: 'human', file: file.rel }],
    });

    if (!purpose && /^readme\.md$/i.test(path.basename(file.rel)) && file.rel.split('/').length === 1) {
      purpose = summary;
    }

    for (const node of nodes.values()) {
      if (node.kind !== 'contract') continue;
      if (new RegExp(`\\b${escapeRegex(node.title)}\\b`).test(source)) {
        addEdge({
          from: id,
          to: node.id,
          kind: 'documents',
          provenance: [{ source: 'human', file: file.rel }],
        });
      }
    }
  }

  return purpose;
}

function indexScripts(files: FileEntry[], addNode: AddNode): void {
  const isScript = (rel: string, ext: string) =>
    ext === '.sh' ||
    /(^|\/)Makefile$/.test(rel) ||
    /(^|\/)justfile$/i.test(rel) ||
    /^\.github\/workflows\/.+\.ya?ml$/.test(rel);

  for (const file of files) {
    if (!isScript(file.rel, file.ext)) continue;
    addNode({
      id: `script:${file.rel}`,
      kind: 'script',
      title: path.basename(file.rel),
      path: file.rel,
      summary: /workflows/.test(file.rel) ? 'CI workflow.' : 'Build or deploy script.',
      provenance: [{ source: 'config', file: file.rel }],
    });
  }
}

const TASK_MARKER = /(?:\/\/|#|<!--|\*)\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.+)/;

async function indexTasks(
  root: string,
  files: FileEntry[],
  addNode: AddNode,
  addEdge: AddEdge,
  nodes: Map<string, MemoryNode>,
): Promise<void> {
  const candidates = files.filter(
    (f) => ['.rs', '.md', '.toml', '.ts', '.js', '.sh'].includes(f.ext) && !f.rel.startsWith('.stellar-memory/'),
  );

  for (const file of candidates) {
    const source = await readFileSafe(file);
    if (!source) continue;
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      let title: string | undefined;
      let marker = 'TODO';

      const m = TASK_MARKER.exec(line);
      if (m?.[2]) {
        marker = m[1] ?? 'TODO';
        title = m[2].replace(/-->\s*$/, '').trim();
      } else if (file.ext === '.md') {
        const box = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
        if (box?.[1]) {
          marker = 'CHECKLIST';
          title = box[1].trim();
        }
      }

      if (!title) continue;
      const id = `task:${file.rel}#${i + 1}`;
      addNode({
        id,
        kind: 'task',
        title: truncate(title, 90),
        path: file.rel,
        line: i + 1,
        summary: `${marker} in \`${file.rel}:${i + 1}\``,
        provenance: [{ source: 'source', file: file.rel, line: i + 1 }],
      });

      for (const node of nodes.values()) {
        if (node.kind !== 'contract') continue;
        if (new RegExp(`\\b${escapeRegex(node.title)}\\b`, 'i').test(title)) {
          addEdge({ from: id, to: node.id, kind: 'mentions', provenance: [] });
        }
      }
    }
  }
}

interface EnrichArgs {
  root: string;
  networks: string[];
  nodes: Map<string, MemoryNode>;
  addNode: AddNode;
  addEdge: AddEdge;
  contractCrate: Map<string, string>;
  warnings: string[];
  progress: (m: string) => void;
}

/**
 * Attach on-chain reality to the source graph: which contracts are deployed
 * where, and whether what is deployed still matches what is in the tree.
 */
async function enrichOnChain(args: EnrichArgs): Promise<number> {
  const { root, networks, nodes, addNode, addEdge, contractCrate, warnings, progress } = args;

  // Local Wasm hashes first, so drift can be computed without a second pass.
  const localHash = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== 'contract') continue;
    const crate = contractCrate.get(node.title);
    if (!crate) continue;
    for (const candidate of [wasmArtifactPath(crate), legacyWasmArtifactPath(crate)]) {
      const abs = path.join(root, candidate);
      try {
        await fs.access(abs);
      } catch {
        continue;
      }
      const hash = await fetchWasmHash({ wasm: abs });
      if (hash) {
        localHash.set(node.title, hash);
        const data = node.data as unknown as ContractData;
        data.wasmPath = candidate;
        data.localWasmHash = hash;
        node.provenance.push({
          source: 'stellar-cli',
          command: describeCommand(['contract', 'info', 'hash'], { wasm: candidate }),
        });
      }
      break;
    }
  }

  let count = 0;
  for (const network of networks) {
    const aliases = await listAliases(network, root);
    if (aliases.length === 0) continue;
    progress(`Found ${aliases.length} alias${aliases.length === 1 ? '' : 'es'} on ${network}`);

    for (const alias of aliases) {
      const created = await recordDeployment(alias, network, args, localHash);
      if (created) count++;
    }
  }

  if (count === 0) {
    warnings.push(
      'No contract aliases were found, so no deployments are linked. ' +
        'Run `stellar contract alias add <name> --id <C...> --network <net>` to connect a contract to its address.',
    );
  }

  return count;
}

async function recordDeployment(
  alias: AliasEntry,
  network: string,
  args: EnrichArgs,
  localHash: Map<string, string>,
): Promise<boolean> {
  const { nodes, addNode, addEdge } = args;

  const onChainHash = await fetchWasmHash({ contractId: alias.contractId, network });
  const meta = await fetchMeta({ contractId: alias.contractId, network });

  // Match the alias to a contract in source: by name, then by Wasm hash.
  let matched: MemoryNode | undefined;
  for (const node of nodes.values()) {
    if (node.kind !== 'contract') continue;
    const byName = node.title.toLowerCase().replace(/contract$/, '') === alias.alias.toLowerCase().replace(/-/g, '');
    const byHash = onChainHash && localHash.get(node.title) === onChainHash;
    if (byName || byHash) {
      matched = node;
      break;
    }
  }

  const local = matched ? localHash.get(matched.title) : undefined;
  const drift: DeploymentData['drift'] =
    !onChainHash || !local ? 'unknown' : onChainHash === local ? 'in-sync' : 'stale';

  const data: DeploymentData = {
    network,
    contractId: alias.contractId,
    onChainWasmHash: onChainHash ?? undefined,
    alias: alias.alias,
    drift,
    meta: meta ?? undefined,
  };

  const id = `deployment:${network}.${alias.contractId}`;
  addNode({
    id,
    kind: 'deployment',
    title: `${alias.alias} @ ${network}`,
    summary: `Live at \`${alias.contractId}\`${drift === 'stale' ? ' — out of sync with local source' : ''}.`,
    data: data as unknown as Record<string, unknown>,
    provenance: [
      {
        source: 'stellar-cli',
        command: describeCommand(['contract', 'info', 'hash'], { contractId: alias.contractId }),
        network,
      },
    ],
  });

  if (matched) {
    addEdge({
      from: matched.id,
      to: id,
      kind: 'deployed_as',
      note: drift === 'stale' ? 'deployed build is older than source' : undefined,
      provenance: [{ source: 'stellar-cli', command: 'stellar contract alias ls', network }],
    });
  }

  // The deployed interface is ground truth; record it alongside the parsed one.
  const spec = await fetchInterface({ contractId: alias.contractId, network });
  if (spec && matched) {
    const parsedFns = new Set(((matched.data as unknown as ContractData).functions ?? []));
    const onChainFns = spec.functions.map((f) => f.name);
    const onlyOnChain = onChainFns.filter((f) => !parsedFns.has(f));
    (nodes.get(id)!.data as unknown as DeploymentData & { interface?: unknown }).interface = {
      functions: spec.functions.map((f) => ({ signature: formatSignature(f), doc: docSummary(f.doc) })),
      events: spec.events.map((e) => e.name),
    };
    if (onlyOnChain.length > 0) {
      nodes.get(id)!.summary +=
        ` Exposes ${onlyOnChain.length} function${onlyOnChain.length === 1 ? '' : 's'} not found in local source.`;
    }

    // Error discriminants are ABI. Comparing the deployed spec against source
    // catches a renumbered variant — a break that is otherwise invisible until
    // a client starts misreporting failures.
    for (const deployed of spec.errors) {
      const sourceNode = nodes.get(`error:${deployed.name}`);
      const sourceData = sourceNode?.data as unknown as ErrorData | undefined;
      if (!sourceNode || !sourceData?.variants?.length || !deployed.cases?.length) continue;

      const onChain = new Map(deployed.cases.map((c) => [c.name, c.value]));
      const drifted = sourceData.variants.filter(
        (v) => onChain.has(v.name) && onChain.get(v.name) !== v.code,
      );
      if (drifted.length > 0) {
        sourceData.deployedMismatch = drifted
          .map((v) => `${v.name} is ${v.code} in source but ${onChain.get(v.name)} on ${network}`)
          .join('; ');
      }
    }
  }

  return true;
}

/**
 * Carry forward firstSeen dates and mark what actually changed, so `resume` can
 * answer "what moved while I was away" rather than re-listing the whole project.
 */
function reconcileWithPrevious(
  memory: ProjectMemory,
  previous: ProjectMemory | null,
  now: string,
): string[] {
  if (!previous) return memory.nodes.map((n) => n.id);

  const before = new Map(previous.nodes.map((n) => [n.id, n]));
  const changed: string[] = [];

  for (const node of memory.nodes) {
    const old = before.get(node.id);
    if (!old) {
      changed.push(node.id);
      continue;
    }
    node.firstSeen = old.firstSeen;
    if (fingerprint(old) === fingerprint(node)) {
      node.lastChanged = old.lastChanged;
    } else {
      node.lastChanged = now;
      changed.push(node.id);
    }
  }

  // Nodes that vanished are a change worth reporting too.
  const nowIds = new Set(memory.nodes.map((n) => n.id));
  for (const old of previous.nodes) {
    if (!nowIds.has(old.id)) changed.push(`removed:${old.id}`);
  }

  return changed;
}

function fingerprint(node: MemoryNode): string {
  return JSON.stringify({
    kind: node.kind,
    title: node.title,
    path: node.path,
    summary: node.summary,
    data: node.data,
  });
}

function firstProse(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const buffer: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buffer.length > 0) break;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^[![]/.test(line)) continue; // badges and images
    if (line.startsWith('```')) break;
    buffer.push(line);
    if (buffer.join(' ').length > 200) break;
  }
  const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
  return text ? truncate(text, 300) : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A label with enough path to be distinguishable. Soroban workspaces are full of
 * files called `lib.rs` and `test.rs`, and a list of eight identical names tells
 * a returning developer nothing.
 */
function shortLabel(rel: string): string {
  // Drop the segments every crate shares, so what remains is what differs.
  const parts = rel
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'src' && segment !== 'contracts');
  return parts.slice(-2).join('/') || rel;
}
