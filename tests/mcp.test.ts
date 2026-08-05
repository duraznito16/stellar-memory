/**
 * End-to-end check of the MCP server.
 *
 * Spawns the built CLI as an agent would, speaks real MCP over stdio, and
 * asserts that the tools an agent depends on are advertised and return the
 * project's actual contents. This is the surface the bounty cares about, so it
 * is worth testing for real rather than trusting that the wiring is right.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const demo = path.join(repoRoot, 'demo', 'private-payroll');
const entry = path.join(repoRoot, 'dist', 'index.js');

let client: Client;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--cwd', demo, 'mcp'],
  });
  client = new Client({ name: 'stellar-memory-test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

/** Tool results arrive as content blocks; collapse them to plain text. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
}

test('advertises the agent-facing toolset', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    'describe_node',
    'list_contracts',
    'project_overview',
    'project_signals',
    'recent_changes',
    'search_memory',
    'storage_layout',
  ]);

  // An agent chooses a tool from its description, so every tool needs one.
  for (const tool of tools) {
    assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
  }
});

test('project_overview returns the real project', async () => {
  const body = textOf(await client.callTool({ name: 'project_overview', arguments: {} }));
  assert.match(body, /# Project: private-payroll/);
  assert.match(body, /Payroll/);
  assert.match(body, /Treasury/);
  assert.match(body, /EmployeeRegistry/);
});

test('search_memory finds a contract by name', async () => {
  const body = textOf(
    await client.callTool({ name: 'search_memory', arguments: { query: 'treasury', limit: 5 } }),
  );
  const hits = JSON.parse(body) as { id: string; kind: string }[];
  assert.ok(hits.some((h) => h.id === 'contract:Treasury' && h.kind === 'contract'));
});

test('list_contracts reports the cross-contract call graph', async () => {
  const body = textOf(await client.callTool({ name: 'list_contracts', arguments: {} }));
  const parsed = JSON.parse(body) as {
    contracts: { name: string; calls: string[]; functions: { name: string; requires_auth: boolean }[] }[];
  };

  const payroll = parsed.contracts.find((c) => c.name === 'Payroll');
  assert.ok(payroll, 'Payroll is present');
  assert.deepEqual(payroll!.calls.sort(), ['EmployeeRegistry', 'Treasury']);

  const setPayToken = payroll!.functions.find((f) => f.name === 'set_pay_token');
  assert.equal(setPayToken?.requires_auth, false, 'the unauthenticated setter is reported as such');
});

test('project_signals surfaces the real defects, and only those', async () => {
  const body = textOf(await client.callTool({ name: 'project_signals', arguments: {} }));
  const signals = JSON.parse(body) as { severity: string; message: string }[];
  const warnings = signals.filter((s) => s.severity === 'warn').map((s) => s.message);

  assert.ok(
    warnings.some((m) => /set_pay_token.*require_auth/.test(m)),
    'missing auth on a state-changing entry point',
  );
  assert.ok(
    warnings.some((m) => /LastPaid.*extend_ttl/.test(m)),
    'persistent key with no TTL extension',
  );
  // Treasury and EmployeeRegistry do extend their TTLs — flagging them would be
  // a false positive, and false positives are what make a tool get uninstalled.
  assert.ok(
    !warnings.some((m) => /DataKey::Balance|DataKey::Salary/.test(m)),
    'no false TTL warnings on keys that are extended',
  );

  // Read-only getters must never be reported as unauthenticated mutations.
  // `payroll_address`, `balance`, `salary_of` and `last_paid` only read storage;
  // an earlier name-prefix heuristic flagged `payroll_address` because it starts
  // with "pay".
  for (const getter of ['payroll_address', 'balance', 'salary_of', 'last_paid']) {
    assert.ok(
      !warnings.some((m) => m.includes(`.${getter} `)),
      `${getter} is a getter and must not be flagged as a mutation`,
    );
  }
});

test('describe_node explains a node and its relationships', async () => {
  const body = textOf(
    await client.callTool({ name: 'describe_node', arguments: { id: 'contract:Payroll' } }),
  );
  const parsed = JSON.parse(body) as {
    node: { title: string };
    points_to: { relationship: string; title: string }[];
  };
  assert.equal(parsed.node.title, 'Payroll');
  assert.ok(parsed.points_to.some((p) => p.relationship === 'calls' && p.title === 'Treasury'));
});

test('describe_node suggests alternatives for an unknown id', async () => {
  const body = textOf(
    await client.callTool({ name: 'describe_node', arguments: { id: 'contract:Treasry' } }),
  );
  assert.match(body, /No node with id/);
  assert.match(body, /Did you mean/);
});
