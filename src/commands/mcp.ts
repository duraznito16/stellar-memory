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
  nodesOfKind,
  resumeReport,
  search,
  signals,
  suggestIds,
} from '../core/query.js';
import type {
  AssetData,
  DeploymentData,
  ErrorData,
  FunctionData,
  ProjectMemory,
  StorageData,
} from '../core/types.js';
import { describeAuth } from '../core/query.js';
import { note, dim } from '../ui/out.js';

export interface McpOptions {
  cwd: string;
}

const VERSION = '0.1.0';

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
  const json = (value: unknown) => text(JSON.stringify(value, null, 2));

  server.registerTool(
    'project_overview',
    {
      title: 'Project overview',
      description:
        'A factual digest of this Stellar project: its purpose, contracts and their public ' +
        'functions, cross-contract calls, storage keys, live deployments, and open tasks. ' +
        'Call this first when you need to understand the project before doing anything else.',
    },
    async () => text(contextDigest(await load())),
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
      },
    },
    async ({ query, limit }) => {
      const memory = await load();
      const hits = search(memory, query, limit ?? 10);
      return json(
        hits.map((hit) => ({
          id: hit.node.id,
          kind: hit.node.kind,
          title: hit.node.title,
          path: hit.node.path,
          line: hit.node.line,
          summary: hit.node.summary,
          matched_because: hit.reason,
        })),
      );
    },
  );

  server.registerTool(
    'describe_node',
    {
      title: 'Describe one element and its relationships',
      description:
        'Given an id from search_memory (e.g. "contract:Payroll"), return its detail and every ' +
        'relationship it participates in — what it calls, what calls it, what it reads and writes, ' +
        'where it is deployed, and what tests cover it.',
      inputSchema: {
        id: z.string().describe('Node id, e.g. "contract:Treasury" or "function:Payroll.pay".'),
      },
    },
    async ({ id }) => {
      const memory = await load();
      const hood = neighbourhood(memory, id);
      if (!hood) {
        // Fall back to near-miss ids first (typos, wrong prefix), then to a
        // keyword search, so a wrong guess still points somewhere useful.
        const guesses = suggestIds(memory, id, 5);
        const fallback = guesses.length ? guesses : search(memory, id, 5).map((h) => h.node.id);
        return text(
          `No node with id "${id}".` +
            (fallback.length
              ? ` Did you mean one of: ${fallback.join(', ')}?`
              : ' Use search_memory to find the right id.'),
        );
      }
      return json({
        node: hood.node,
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
      });
    },
  );

  server.registerTool(
    'list_contracts',
    {
      title: 'List Soroban contracts',
      description:
        'Every contract in the project with its crate, public function count, cross-contract ' +
        'calls, test coverage, and where it is deployed on each network.',
    },
    async () => {
      const memory = await load();
      const arch = architecture(memory);
      return json({
        entry_points: arch.entryPoints,
        contracts: arch.contracts.map((c) => ({
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
        'never call require_auth, and contracts with no tests. Call this before making changes.',
    },
    async () => {
      const memory = await load();
      return json(signals(memory));
    },
  );

  server.registerTool(
    'storage_layout',
    {
      title: 'Storage keys and durability',
      description:
        'Every storage key the contracts touch, with its durability (instance, persistent or ' +
        'temporary), whether its TTL is ever extended, and which functions read or write it.',
    },
    async () => {
      const memory = await load();
      return json(
        nodesOfKind(memory, 'storage').map((node) => {
          const data = node.data as unknown as StorageData | undefined;
          const hood = neighbourhood(memory, node.id);
          return {
            key: data?.key,
            durability: data?.durability,
            ttl_extended: data?.hasTtlExtension ?? false,
            source: node.path,
            read_by: hood?.incoming.filter((i) => i.edge.kind === 'reads').map((i) => i.node.title) ?? [],
            written_by: hood?.incoming.filter((i) => i.edge.kind === 'writes').map((i) => i.node.title) ?? [],
          };
        }),
      );
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
    },
    async () => {
      const memory = await load();
      return json({
        assets: nodesOfKind(memory, 'asset').map((node) => {
          const data = node.data as unknown as AssetData | undefined;
          const hood = neighbourhood(memory, node.id);
          return {
            id: node.id,
            title: node.title,
            kind: data?.kind,
            address_origin: data?.addressOrigin,
            address_key: data?.addressKey,
            methods_called: data?.methods ?? [],
            called_from: hood?.incoming.filter((i) => i.edge.kind === 'calls').map((i) => i.node.title) ?? [],
          };
        }),
        errors: nodesOfKind(memory, 'error').map((node) => {
          const data = node.data as unknown as ErrorData | undefined;
          const hood = neighbourhood(memory, node.id);
          return {
            id: node.id,
            name: node.title,
            variants: data?.variants ?? [],
            // Always present, so absence never has to be interpreted.
            deployed_abi_check: data?.deployedCheck ?? 'not-checked',
            disagrees_with_deployed: data?.deployedMismatch ?? null,
            raised_by: hood?.incoming.filter((i) => i.edge.kind === 'raises').map((i) => i.node.title) ?? [],
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
    },
    async () => {
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

      return json({
        project: report.project,
        purpose: report.purpose,
        change_window: report.firstScan
          ? { note: 'Only one scan exists, so there is nothing to diff against. Everything below is first-seen, not changed.' }
          : { from: report.changeWindow?.from, to: report.changeWindow?.to, scans_recorded: report.changeWindow?.scanCount },
        changed,
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
