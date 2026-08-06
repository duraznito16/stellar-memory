/**
 * MCP server — the agent-facing door onto the same memory.
 *
 * Every tool here reads the vault that `scan` wrote, so an agent and a human
 * asking the same question get the same answer from the same index. The memory
 * is re-read per call rather than cached, so a `scan` in another terminal is
 * visible immediately.
 *
 * The transport is stdio, which means **stdout belongs to the protocol**.
 * Nothing in this file may print to stdout; diagnostics go to stderr only.
 *
 * Three properties of this surface are deliberate and easy to lose:
 *
 * - **Every tool declares `readOnlyHint`.** Read-only is the central safety
 *   claim of this project, and a host that cannot see it must ask a human to
 *   approve all eight. Declaring it turns a sentence in the README into
 *   something the protocol itself can check.
 * - **Every tool that returns data declares an `outputSchema`** and answers with
 *   `structuredContent`. An agent then receives typed fields instead of a string
 *   it has to parse and hope about. The same object also goes out as `content`
 *   text, because clients that predate structured output read that, and the two
 *   disagreeing would be worse than either alone.
 * - **Every listing tool takes a filter.** A workspace with three contracts fits
 *   in a reply; one with forty does not, and a tool whose only mode is "return
 *   everything" spends an agent's context before it has asked its real question.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tryLoadMemory } from '../store/vault.js';
import {
  architecture,
  contextDigest,
  neighbourhood,
  missingTtlExtension,
  nodesOfKind,
  resumeReport,
  search,
  signals,
  suggestIds,
  SIGNAL_CATEGORIES,
} from '../core/query.js';
import type {
  AssetData,
  DeploymentData,
  ErrorData,
  FunctionData,
  MemoryNode,
  ProjectMemory,
  StorageData,
} from '../core/types.js';
import { describeAuth } from '../core/query.js';
import { note, dim } from '../ui/out.js';

export interface McpOptions {
  cwd: string;
}

// Reported to every agent that connects, so it must not be a stale literal.
import { VERSION } from '../core/version.js';

/**
 * Nothing here writes, signs, spends, or reaches the network — the vault on
 * disk is the only input. `openWorldHint: false` says the answer depends solely
 * on that local state, which is what makes these safe to call unattended.
 */
const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/* ------------------------------------------------------------------ *
 * Output schema fragments
 *
 * Deliberately permissive on nested detail. The SDK validates every reply
 * against these and rejects the call on a mismatch, so a schema that over-
 * promises turns a scanner improvement into a broken tool. They describe the
 * fields an agent should rely on; anything richer passes through.
 * ------------------------------------------------------------------ */

const nodeRefShape = {
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  summary: z.string().optional(),
};

const memoryNodeSchema = z
  .object({
    ...nodeRefShape,
    data: z.record(z.string(), z.unknown()).optional(),
    provenance: z.array(z.record(z.string(), z.unknown())).optional(),
    firstSeen: z.string().optional(),
    lastChanged: z.string().optional(),
  })
  .passthrough();

const relationSchema = z.object({
  relationship: z.string(),
  id: z.string(),
  title: z.string(),
  note: z.string().optional(),
});

/**
 * Present on every tool that accepts a filter. A caller who mistypes a contract
 * name would otherwise get an empty list and read it as "this project has no
 * storage keys" — the same failure mode `deployedCheck` exists to prevent.
 */
const noteField = {
  note: z
    .string()
    .optional()
    .describe('Set when a filter matched nothing, explaining why the result is empty.'),
};

export async function runMcp(options: McpOptions): Promise<void> {
  const root = path.resolve(options.cwd);

  const server = new McpServer({
    name: 'stellar-memory',
    version: VERSION,
  });

  /** Read the vault fresh on every call so agents never see a stale graph. */
  const load = async (): Promise<ProjectMemory> => {
    const memory = await tryLoadMemory(root);
    if (!memory || memory.nodes.length === 0) {
      throw new Error(
        'This project has no stellar-memory index yet. Run `stellar-memory init` then `stellar-memory scan`.',
      );
    }
    return memory;
  };

  const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

  /**
   * A tool with an outputSchema must answer with `structuredContent` or the SDK
   * rejects the call outright. The identical object is also serialised into
   * `content` for clients that only read text.
   */
  const structured = (value: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  });

  /**
   * Every node id one contract reaches in two hops: the functions it defines,
   * and everything those functions touch — storage keys, errors, events, assets,
   * other contracts.
   *
   * Filtering has to follow edges rather than parse ids. A storage key is tied
   * to a contract only by the `reads`/`writes` edges of that contract's
   * functions; splitting `storage:Payroll.persistent.…` on a dot would work
   * until a key contains one, and `DataKey::LastPaid(employee)` already does.
   *
   * Returns null when no such contract exists, which the caller reports as a
   * bad filter rather than as an empty project.
   */
  const contractScope = (memory: ProjectMemory, contract: string): Set<string> | null => {
    const root = neighbourhood(memory, `contract:${contract}`);
    if (!root) return null;
    const ids = new Set<string>([root.node.id]);
    for (const step of root.outgoing) {
      ids.add(step.node.id);
      const inner = neighbourhood(memory, step.node.id);
      if (!inner) continue;
      for (const leaf of inner.outgoing) ids.add(leaf.node.id);
    }
    return ids;
  };

  /** Contract names, for telling a caller what they could have asked for. */
  const contractNames = (memory: ProjectMemory): string[] =>
    nodesOfKind(memory, 'contract').map((n) => n.title);

  const unknownContract = (memory: ProjectMemory, contract: string): string =>
    `No contract named "${contract}" in this project. Known contracts: ${
      contractNames(memory).join(', ') || 'none'
    }.`;

  server.registerTool(
    'project_overview',
    {
      title: 'Project overview',
      description:
        'A factual digest of this Stellar project: its purpose, contracts and their public ' +
        'functions, cross-contract calls, storage keys, live deployments, and open tasks. ' +
        'Call this first when you need to understand the project before doing anything else. ' +
        'Returns prose meant to be read, not fields to be parsed — the other tools return data.',
      inputSchema: {
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(60_000)
          .optional()
          .describe('Truncate the digest to roughly this many characters (default 12000).'),
      },
      annotations: READ_ONLY,
    },
    async ({ max_chars }) => text(contextDigest(await load(), max_chars ?? 12_000)),
  );

  server.registerTool(
    'search_memory',
    {
      title: 'Search the project memory',
      description:
        'Find contracts, functions, types, storage keys, deployments, tests, docs or tasks ' +
        'by name or keyword. Use this to locate something before describing it.',
      inputSchema: {
        query: z.string().describe('What to look for, e.g. "treasury" or "withdraw".'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
        kind: z
          .string()
          .optional()
          .describe(
            'Restrict to one node kind, e.g. "contract", "function", "storage", "deployment", "asset", "task".',
          ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            ...nodeRefShape,
            matched_because: z.string(),
          }),
        ),
        ...noteField,
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, kind }) => {
      const memory = await load();
      const want = limit ?? 10;

      // Ranking has to happen before the kind filter, not after: searching with
      // the caller's limit and then filtering would drop matches that ranked
      // below unrelated nodes of other kinds.
      const ranked = search(memory, query, kind ? memory.nodes.length : want);
      const filtered = kind ? ranked.filter((hit) => hit.node.kind === kind) : ranked;
      const hits = filtered.slice(0, want);

      // Widened to string: the caller's `kind` is free text, and comparing it
      // against the kinds actually present is how they learn which are valid.
      const kinds: string[] = [...new Set(memory.nodes.map((n) => String(n.kind)))].sort();
      const note =
        kind && !kinds.includes(kind)
          ? `No node in this project has kind "${kind}". Kinds present: ${kinds.join(', ')}.`
          : hits.length === 0
            ? `Nothing matched "${query}"${kind ? ` with kind "${kind}"` : ''}.`
            : undefined;

      return structured({
        results: hits.map((hit) => ({
          id: hit.node.id,
          kind: hit.node.kind,
          title: hit.node.title,
          path: hit.node.path,
          line: hit.node.line,
          summary: hit.node.summary,
          matched_because: hit.reason,
        })),
        ...(note ? { note } : {}),
      });
    },
  );

  server.registerTool(
    'describe_node',
    {
      title: 'Describe one element and its relationships',
      description:
        'Given an id from search_memory (e.g. "contract:Payroll"), return its detail and every ' +
        'relationship it participates in — what it calls, what calls it, what it reads and writes, ' +
        'where it is deployed, and what tests cover it. When the id is wrong, `found` is false and ' +
        '`suggestions` holds the ids you probably meant.',
      inputSchema: {
        id: z.string().describe('Node id, e.g. "contract:Treasury" or "function:Payroll.pay".'),
      },
      outputSchema: {
        found: z.boolean(),
        node: memoryNodeSchema.optional(),
        points_to: z.array(relationSchema),
        pointed_to_by: z.array(relationSchema),
        suggestions: z
          .array(z.string())
          .describe('Ids to try instead. Empty when the node was found.'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const memory = await load();
      const hood = neighbourhood(memory, id);
      if (!hood) {
        // Fall back to near-miss ids first (typos, wrong prefix), then to a
        // keyword search, so a wrong guess still points somewhere useful.
        const guesses = suggestIds(memory, id, 5);
        const fallback = guesses.length ? guesses : search(memory, id, 5).map((h) => h.node.id);
        const body = {
          found: false,
          points_to: [],
          pointed_to_by: [],
          suggestions: fallback,
        };
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `No node with id "${id}".` +
                (fallback.length
                  ? ` Did you mean one of: ${fallback.join(', ')}?`
                  : ' Use search_memory to find the right id.'),
            },
          ],
          structuredContent: body,
        };
      }
      return structured({
        found: true,
        node: hood.node as unknown as Record<string, unknown>,
        points_to: hood.outgoing.map((o) => ({
          relationship: o.edge.kind,
          id: o.node.id,
          title: o.node.title,
          note: o.edge.note,
        })),
        pointed_to_by: hood.incoming.map((i) => ({
          relationship: i.edge.kind,
          id: i.node.id,
          title: i.node.title,
          note: i.edge.note,
        })),
        suggestions: [],
      });
    },
  );

  server.registerTool(
    'list_contracts',
    {
      title: 'List Soroban contracts',
      description:
        'Every contract in the project with its crate, public functions and their authorization, ' +
        'cross-contract calls, test coverage, and where it is deployed on each network. ' +
        'Pass `contract` to get just one instead of the whole workspace.',
      inputSchema: {
        contract: z
          .string()
          .optional()
          .describe('Restrict to one contract by name, e.g. "Payroll".'),
      },
      outputSchema: {
        entry_points: z
          .array(z.string())
          .describe('Contracts nothing else calls — the way into the system.'),
        contracts: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              crate: z.string().optional(),
              source: z.string().optional(),
              functions: z.array(
                z
                  .object({
                    name: z.string(),
                    params: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()),
                    returns: z.string().optional(),
                    requires_auth: z.boolean(),
                    authorizes: z.array(
                      z
                        .object({
                          subject: z.string(),
                          origin: z.string(),
                          storage_key: z.string().optional(),
                          gates_callers: z.boolean(),
                        })
                        .passthrough(),
                    ),
                    auth_summary: z.string(),
                  })
                  .passthrough(),
              ),
              calls: z.array(z.string()),
              called_by: z.array(z.string()),
              tested_by: z.array(z.string()),
              deployments: z.array(
                z
                  .object({
                    network: z.string().optional(),
                    contract_id: z.string().optional(),
                    matches_local_build: z.string().optional(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
        ...noteField,
      },
      annotations: READ_ONLY,
    },
    async ({ contract }) => {
      const memory = await load();
      const arch = architecture(memory);

      if (contract && !contractNames(memory).includes(contract)) {
        return structured({
          entry_points: [],
          contracts: [],
          note: unknownContract(memory, contract),
        });
      }

      const wanted = contract
        ? arch.contracts.filter((c) => c.node.title === contract)
        : arch.contracts;

      return structured({
        entry_points: arch.entryPoints,
        contracts: wanted.map((c) => ({
          id: c.node.id,
          name: c.node.title,
          crate: c.crate,
          source: c.node.path,
          functions: c.functions.map((f) => {
            const d = f.data as unknown as FunctionData | undefined;
            return {
              name: f.title,
              params: d?.params ?? [],
              returns: d?.returns,
              // `requires_auth` alone said `true` for the three initializers
              // that anyone can call and claim admin on. An agent auditing
              // access control reaches for this tool by name and got the
              // security-critical answer backwards, so the subject travels with
              // the boolean and the prose says what the boolean cannot.
              requires_auth: d?.requiresAuth ?? false,
              authorizes: (d?.authSubjects ?? []).map((s) => ({
                subject: s.expr,
                origin: s.origin,
                storage_key: s.key,
                gates_callers: s.origin === 'storage' || s.origin === 'guard-macro',
              })),
              auth_summary: describeAuth(d).replace(/^ \[|\]$/g, '') || 'no authorization',
            };
          }),
          calls: c.calls.map((n) => n.title),
          called_by: c.calledBy.map((n) => n.title),
          tested_by: c.tests.map((n) => n.path ?? n.title),
          deployments: c.deployments.map((d) => {
            const data = d.data as unknown as DeploymentData | undefined;
            return {
              network: data?.network,
              contract_id: data?.contractId,
              matches_local_build: data?.drift,
            };
          }),
        })),
      });
    },
  );

  server.registerTool(
    'project_signals',
    {
      title: 'Things worth knowing about this project',
      description:
        'Facts derived from hard data that a developer would want flagged: deployments whose ' +
        'on-chain Wasm no longer matches local source, persistent storage keys with no ' +
        'extend_ttl (which can expire and become unreachable), state-changing entry points that ' +
        'never call require_auth, and contracts with no tests. Call this before making changes. ' +
        'Filter by `category` when you are auditing one dimension, or by `severity` to see only warnings.',
      inputSchema: {
        category: z
          .enum(SIGNAL_CATEGORIES as [string, ...string[]])
          .optional()
          .describe('Restrict to one category of finding.'),
        severity: z
          .enum(['info', 'warn'])
          .optional()
          .describe('Restrict to one severity.'),
      },
      outputSchema: {
        signals: z.array(
          z
            .object({
              severity: z.string(),
              category: z.string(),
              message: z.string(),
              // Kept camelCase to match the shape `check --json` and the README
              // already publish. Renaming it here would split one documented
              // field across two spellings.
              nodeId: z.string().optional(),
              scope: z.string().optional(),
            })
            .passthrough(),
        ),
        ...noteField,
      },
      annotations: READ_ONLY,
    },
    async ({ category, severity }) => {
      const memory = await load();
      const all = signals(memory);
      const found = all.filter(
        (s) => (!category || s.category === category) && (!severity || s.severity === severity),
      );

      const note =
        found.length === 0
          ? all.length === 0
            ? 'This project has no signals at all — nothing was flagged.'
            : `No signals match that filter. Categories present: ${
                [...new Set(all.map((s) => s.category))].sort().join(', ')
              }.`
          : undefined;

      return structured({ signals: found, ...(note ? { note } : {}) });
    },
  );

  server.registerTool(
    'storage_layout',
    {
      title: 'Storage keys and durability',
      description:
        'Every storage key the contracts touch, with its durability (instance, persistent or ' +
        'temporary), whether its TTL is ever extended, and which functions read or write it. ' +
        'Pass `missing_ttl_only` to see just the persistent keys that can expire, which is the ' +
        'Soroban footgun this tool exists to catch.',
      inputSchema: {
        contract: z.string().optional().describe('Only keys touched by this contract.'),
        durability: z
          .enum(['instance', 'persistent', 'temporary'])
          .optional()
          .describe('Only keys of this durability.'),
        missing_ttl_only: z
          .boolean()
          .optional()
          .describe('Only persistent keys with no extend_ttl — the ones that can become unreachable.'),
      },
      outputSchema: {
        keys: z.array(
          z
            .object({
              id: z.string(),
              key: z.string().optional(),
              durability: z.string().optional(),
              ttl_extended: z.boolean(),
              can_expire: z
                .boolean()
                .describe('The key can archive and become unreachable. This is the question to ask.'),
              source: z.string().optional(),
              read_by: z.array(z.string()),
              written_by: z.array(z.string()),
            })
            .passthrough(),
        ),
        ...noteField,
      },
      annotations: READ_ONLY,
    },
    async ({ contract, durability, missing_ttl_only }) => {
      const memory = await load();

      let scope: Set<string> | null = null;
      if (contract) {
        scope = contractScope(memory, contract);
        if (!scope) {
          return structured({ keys: [], note: unknownContract(memory, contract) });
        }
      }

      const rows = nodesOfKind(memory, 'storage')
        .filter((node) => !scope || scope.has(node.id))
        .map((node) => {
          const data = node.data as unknown as StorageData | undefined;
          const hood = neighbourhood(memory, node.id);
          return {
            id: node.id,
            key: data?.key,
            durability: data?.durability,
            ttl_extended: data?.hasTtlExtension ?? false,
            // The rule about which keys can expire lives in core/query. Three
            // surfaces restating it is how the window and the CI gate came to
            // disagree about the same key in the first place.
            can_expire: data ? missingTtlExtension(data) : false,
            source: node.path,
            read_by:
              hood?.incoming.filter((i) => i.edge.kind === 'reads').map((i) => i.node.title) ?? [],
            written_by:
              hood?.incoming.filter((i) => i.edge.kind === 'writes').map((i) => i.node.title) ?? [],
          };
        })
        .filter((row) => !durability || row.durability === durability)
        .filter((row) => !missing_ttl_only || row.can_expire);

      const note =
        rows.length === 0
          ? missing_ttl_only
            ? 'No persistent key is missing a TTL extension. Nothing here can silently expire.'
            : 'No storage key matches that filter.'
          : undefined;

      return structured({ keys: rows, ...(note ? { note } : {}) });
    },
  );

  server.registerTool(
    'value_surface',
    {
      title: 'Where this project moves value, and how it can fail',
      description:
        'The token and Stellar Asset Contract clients this project calls — which methods it ' +
        'invokes on them, and whether each address is configured in storage or supplied by the ' +
        'caller. Also the contract error enums with their published discriminants, which clients ' +
        'match on. Call this before changing anything that transfers funds or returns an error.',
      inputSchema: {
        contract: z
          .string()
          .optional()
          .describe('Only the assets and errors reachable from this contract.'),
      },
      outputSchema: {
        assets: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              kind: z.string().optional(),
              address_origin: z.string().optional(),
              address_key: z.string().optional(),
              methods_called: z.array(z.string()),
              called_from: z.array(z.string()),
            })
            .passthrough(),
        ),
        errors: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              variants: z.array(
                z.object({ name: z.string(), code: z.number() }).passthrough(),
              ),
              deployed_abi_check: z.string(),
              disagrees_with_deployed: z.string().nullable(),
              raised_by: z.array(z.string()),
            })
            .passthrough(),
        ),
        ...noteField,
      },
      annotations: READ_ONLY,
    },
    async ({ contract }) => {
      const memory = await load();

      let scope: Set<string> | null = null;
      if (contract) {
        scope = contractScope(memory, contract);
        if (!scope) {
          return structured({ assets: [], errors: [], note: unknownContract(memory, contract) });
        }
      }

      const inScope = (node: MemoryNode) => !scope || scope.has(node.id);

      return structured({
        assets: nodesOfKind(memory, 'asset')
          .filter(inScope)
          .map((node) => {
            const data = node.data as unknown as AssetData | undefined;
            const hood = neighbourhood(memory, node.id);
            return {
              id: node.id,
              title: node.title,
              kind: data?.kind,
              address_origin: data?.addressOrigin,
              address_key: data?.addressKey,
              methods_called: data?.methods ?? [],
              called_from:
                hood?.incoming.filter((i) => i.edge.kind === 'calls').map((i) => i.node.title) ?? [],
            };
          }),
        errors: nodesOfKind(memory, 'error')
          .filter(inScope)
          .map((node) => {
            const data = node.data as unknown as ErrorData | undefined;
            const hood = neighbourhood(memory, node.id);
            return {
              id: node.id,
              name: node.title,
              variants: data?.variants ?? [],
              // Always present, so absence never has to be interpreted.
              deployed_abi_check: data?.deployedCheck ?? 'not-checked',
              disagrees_with_deployed: data?.deployedMismatch ?? null,
              raised_by:
                hood?.incoming.filter((i) => i.edge.kind === 'raises').map((i) => i.node.title) ?? [],
            };
          }),
      });
    },
  );

  server.registerTool(
    'recent_changes',
    {
      title: 'What changed recently',
      description:
        'What moved in this project since the previous scan, plus open tasks and TODOs. ' +
        'Use this to reorient before continuing work someone left in progress.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Cap how many changed nodes come back (default: all of them).'),
      },
      outputSchema: {
        project: z.string(),
        purpose: z.string().optional(),
        change_window: z.record(z.string(), z.unknown()),
        changed: z.array(
          z
            .object({
              id: z.string(),
              kind: z.string(),
              title: z.string(),
              path: z.string().optional(),
              reason: z.string(),
            })
            .passthrough(),
        ),
        total_changed: z
          .number()
          .describe('How many nodes changed in all, before `limit` was applied.'),
        open_tasks: z.array(
          z
            .object({
              title: z.string(),
              path: z.string().optional(),
              line: z.number().optional(),
            })
            .passthrough(),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const memory = await load();
      const report = resumeReport(memory, new Date().toISOString());
      const changed = report.changedSinceLastScan.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        path: n.path,
        // On the first scan everything is "changed" only in the sense of being
        // seen for the first time. Reporting that as a change history invents a
        // diff that never happened.
        reason: report.firstScan || n.firstSeen === n.lastChanged ? 'first-seen' : 'content-changed',
      }));

      return structured({
        project: report.project,
        purpose: report.purpose,
        change_window: report.firstScan
          ? {
              note: 'Only one scan exists, so there is nothing to diff against. Everything below is first-seen, not changed.',
            }
          : {
              from: report.changeWindow?.from,
              to: report.changeWindow?.to,
              scans_recorded: report.changeWindow?.scanCount,
            },
        changed: limit ? changed.slice(0, limit) : changed,
        total_changed: changed.length,
        open_tasks: report.openTasks.map((t) => ({
          title: t.title,
          path: t.path,
          line: t.line,
        })),
      });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is the MCP wire.
  note(dim(`stellar-memory MCP server ready (vault: ${root})`));
}
