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

/**
 * The same reply also arrives as typed fields. Tools that declare an
 * outputSchema must populate this — the SDK rejects the call otherwise — so an
 * agent never has to parse a string and hope.
 */
function structuredOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
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
    'value_surface',
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
  const { results } = JSON.parse(body) as { results: { id: string; kind: string }[] };
  assert.ok(results.some((h) => h.id === 'contract:Treasury' && h.kind === 'contract'));
});

test('search_memory narrows to one kind without losing lower-ranked matches', async () => {
  const body = textOf(
    await client.callTool({
      name: 'search_memory',
      arguments: { query: 'pay', kind: 'storage', limit: 20 },
    }),
  );
  const { results } = JSON.parse(body) as { results: { id: string; kind: string }[] };

  assert.ok(results.length > 0, 'storage keys mentioning "pay" exist in the demo');
  // Ranking runs before the filter. Filtering a page of ten mixed results would
  // drop storage keys that ranked below unrelated contracts and functions.
  assert.ok(results.every((h) => h.kind === 'storage'));
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
  const { signals } = JSON.parse(body) as { signals: { severity: string; message: string }[] };
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

test('value_surface reports error discriminants as published ABI', async () => {
  const body = textOf(await client.callTool({ name: 'value_surface', arguments: {} }));
  const parsed = JSON.parse(body) as {
    errors: { name: string; variants: { name: string; code: number }[]; raised_by: string[] }[];
  };

  const payrollError = parsed.errors.find((e) => e.name === 'PayrollError');
  assert.ok(payrollError, 'PayrollError is present');
  assert.deepEqual(
    payrollError!.variants.sort((a, b) => a.code - b.code),
    [
      { name: 'NotAuthorized', code: 1 },
      { name: 'UnknownEmployee', code: 2 },
      { name: 'AlreadyPaidThisPeriod', code: 3 },
      { name: 'NotInitialized', code: 4 },
    ].sort((a, b) => a.code - b.code),
  );

  // `pay` returns Result<i128, PayrollError>, so the raises edge must exist.
  assert.ok(payrollError!.raised_by.includes('pay'), 'the raises edge is emitted');
});

test('describe_node suggests alternatives for an unknown id', async () => {
  const body = textOf(
    await client.callTool({ name: 'describe_node', arguments: { id: 'contract:Treasry' } }),
  );
  assert.match(body, /No node with id/);
  assert.match(body, /Did you mean/);
});

test('every tool declares itself read-only', async () => {
  const { tools } = await client.listTools();

  // Read-only is this project's central safety claim. A host that cannot see it
  // has to ask a human to approve all eight calls, so the claim has to live in
  // the protocol and not only in the README.
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must declare readOnlyHint`);
    assert.equal(
      tool.annotations?.openWorldHint,
      false,
      `${tool.name} answers from the local vault alone`,
    );
  }
});

test('data tools advertise an output schema, and the two encodings agree', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of [
    'search_memory',
    'describe_node',
    'list_contracts',
    'project_signals',
    'storage_layout',
    'value_surface',
    'recent_changes',
  ]) {
    assert.ok(byName.get(name)?.outputSchema, `${name} needs an outputSchema`);
  }
  // The digest is prose meant to be read. Wrapping it in a field would be
  // ceremony, so it stays a text tool and this asserts that is deliberate.
  assert.equal(byName.get('project_overview')?.outputSchema, undefined);

  const result = await client.callTool({ name: 'list_contracts', arguments: {} });
  const structured = structuredOf(result);
  assert.ok(Array.isArray(structured.contracts), 'structuredContent carries the contracts');
  // A client reading text and a client reading fields must never be told
  // different things about the same project.
  assert.deepEqual(JSON.parse(textOf(result)), structured);
});

test('list_contracts filters to one contract, and explains an empty result', async () => {
  const one = structuredOf(
    await client.callTool({ name: 'list_contracts', arguments: { contract: 'Treasury' } }),
  ) as { contracts: { name: string }[] };
  assert.deepEqual(
    one.contracts.map((c) => c.name),
    ['Treasury'],
  );

  const bad = structuredOf(
    await client.callTool({ name: 'list_contracts', arguments: { contract: 'Treasry' } }),
  ) as { contracts: unknown[]; note?: string };
  assert.equal(bad.contracts.length, 0);
  // An unexplained empty list reads as "this project has no contracts", which
  // is a worse answer than an error.
  assert.match(bad.note ?? '', /No contract named/);
  assert.match(bad.note ?? '', /Treasury/, 'the note names what could have been asked for');
});

test('storage_layout isolates the keys that can silently expire', async () => {
  const result = structuredOf(
    await client.callTool({ name: 'storage_layout', arguments: { missing_ttl_only: true } }),
  ) as { keys: { key?: string; durability?: string; ttl_extended: boolean }[] };

  assert.ok(result.keys.length > 0, 'the demo ships one such key on purpose');
  assert.ok(result.keys.every((k) => k.durability === 'persistent' && !k.ttl_extended));
  assert.ok(result.keys.some((k) => /LastPaid/.test(k.key ?? '')));
  // Balance and Salary do extend their TTLs. Listing them here would be the
  // false positive this whole tool exists to avoid.
  assert.ok(!result.keys.some((k) => /Balance|Salary/.test(k.key ?? '')));
});

test('project_signals filters by category', async () => {
  const result = structuredOf(
    await client.callTool({ name: 'project_signals', arguments: { category: 'ttl' } }),
  ) as { signals: { category: string }[] };

  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.every((s) => s.category === 'ttl'));
});

test('a contract filter follows edges rather than parsing ids', async () => {
  // `DataKey::LastPaid(employee)` contains a dot inside its parentheses, so any
  // filter that split the node id on "." would lose it.
  const scoped = structuredOf(
    await client.callTool({ name: 'storage_layout', arguments: { contract: 'Payroll' } }),
  ) as { keys: { key?: string }[] };

  assert.ok(scoped.keys.some((k) => /LastPaid/.test(k.key ?? '')));
  // Treasury's own balance key is reached only through Treasury's functions.
  assert.ok(!scoped.keys.some((k) => /DataKey::Balance/.test(k.key ?? '')));
});

test('describe_node reports a miss as data, not only as prose', async () => {
  const result = structuredOf(
    await client.callTool({ name: 'describe_node', arguments: { id: 'contract:Treasry' } }),
  ) as { found: boolean; suggestions: string[] };

  assert.equal(result.found, false);
  assert.ok(result.suggestions.includes('contract:Treasury'), 'the near miss is offered as an id');
});
