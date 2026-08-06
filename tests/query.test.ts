/**
 * One index, read three ways.
 *
 * The vault note a human opens, the gate CI runs and the tool an agent calls all
 * read the same nodes, so a question with one answer in the index must not come
 * out with two. Each test here is one place they were found to disagree — a
 * warning on a note that the gate exited zero on, a search whose only miss was
 * the thing it was asked for, an age that rounded eleven months down to today,
 * a deployment the graph called "in sync" that had never been compared to
 * anything.
 *
 * Against `src`, not `dist`: these are properties of the reading code itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./src-specifiers.mjs', import.meta.url);

const { driftState, missingTtlExtension, search, signals } = await import('../src/core/query.ts');
const { renderNoteBody } = await import('../src/store/render.ts');
const { humanAge } = await import('../src/core/git.ts');
const { loadMemory } = await import('../src/store/vault.ts');
const { runGraph } = await import('../src/commands/graph.ts');
const { runResume } = await import('../src/commands/resume.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
// The demo's own vault: a real project's nodes, with the storage shapes and the
// auth subjects that made each of these wrong in the first place.
const memory = await loadMemory(path.join(here, '..', 'demo', 'private-payroll'));

type Storage = { durability: string; key: string; hasTtlExtension: boolean };
const storageOf = (node: { data?: Record<string, unknown> }) =>
  node.data as unknown as Storage;

function noteBody(node: (typeof memory)['nodes'][number]): string {
  return renderNoteBody(node, {
    byId: new Map(memory.nodes.map((n) => [n.id, n])),
    outgoing: memory.edges.filter((e) => e.from === node.id),
    incoming: memory.edges.filter((e) => e.to === node.id),
    memory,
  });
}

/* ------------------------------------------------------------------ *
 * TTL: the note and the gate
 * ------------------------------------------------------------------ */

test('the vault note and the ttl gate flag the same keys', () => {
  // The note warned on anything but `temporary`, the gate only on `persistent`.
  // For an instance key the vault showed a ⚠️ and `check --fail-on ttl` exited 0
  // in silence, so the artifact a human reads contradicted the artifact CI reads.
  const flagged = new Set(
    signals(memory).filter((s) => s.category === 'ttl').map((s) => s.nodeId),
  );
  const storage = memory.nodes.filter((n) => n.kind === 'storage');

  assert.ok(storage.length > 0, 'the demo has storage keys to disagree about');
  assert.ok(flagged.size > 0, 'and at least one key that genuinely can expire');
  assert.ok(
    storage.some((n) => storageOf(n).durability === 'instance'),
    'and instance keys, which is where the two rules parted',
  );

  for (const node of storage) {
    assert.equal(
      noteBody(node).includes('No `extend_ttl` call was found'),
      flagged.has(node.id),
      `${node.id}: the note and the ttl gate must say the same thing about it`,
    );
  }
});

test('an instance key with no extend_ttl is not a finding on any surface', () => {
  // `instance().extend_ttl(threshold, extend_to)` takes ledger numbers and names
  // no key, so the scanner has no entry to record it against: `hasTtlExtension`
  // is false on every instance key however diligently the contract extends it.
  // A warning no correct code can clear is a false positive on all of them.
  assert.equal(
    missingTtlExtension({ durability: 'instance', key: 'DataKey::Admin', hasTtlExtension: false }),
    false,
  );
  assert.equal(
    missingTtlExtension({ durability: 'temporary', key: 'DataKey::Nonce(user)', hasTtlExtension: false }),
    false,
  );
  assert.equal(
    missingTtlExtension({
      durability: 'persistent',
      key: 'DataKey::LastPaid(employee)',
      hasTtlExtension: false,
    }),
    true,
  );
  assert.equal(
    missingTtlExtension({
      durability: 'persistent',
      key: 'DataKey::Salary(employee)',
      hasTtlExtension: true,
    }),
    false,
  );
});

/* ------------------------------------------------------------------ *
 * Drift: the three states
 * ------------------------------------------------------------------ */

/** picocolors decides from the terminal, and on Windows it decides yes on a pipe. */
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
const plain = (text: string) => text.replace(ESCAPES, '');

/** `resume` writes its briefing to stdout and takes no sink. */
async function captureOut(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = real;
  }
  return plain(chunks.join(''));
}

test('a drift check that never ran is not reported as agreement', async (t) => {
  // `unknown` means one of the two Wasm hashes was missing and nothing was
  // compared. Every surface branched on `=== 'stale'` and painted the remainder
  // green, so with the hash read gone the graph reported `testnet (in sync)` for
  // all three demo contracts — the treasury among them, which is genuinely out
  // of sync. This is the demo's own vault with the hashes taken back off it,
  // which is exactly the shape a scan produces when the CLI cannot answer.
  const raw = JSON.parse(
    await fs.readFile(path.join(here, '..', 'demo', 'private-payroll', '.stellar-memory', 'index.json'), 'utf8'),
  ) as { nodes: { kind: string; data?: Record<string, unknown> }[] };

  for (const node of raw.nodes) {
    if (node.kind !== 'deployment' || !node.data) continue;
    node.data.drift = 'unknown';
    delete node.data.onChainWasmHash;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-drift-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.stellar-memory'));
  await fs.writeFile(path.join(root, '.stellar-memory', 'index.json'), JSON.stringify(raw), 'utf8');

  await runGraph({ cwd: root, out: 'graph.txt' });
  const tree = await fs.readFile(path.join(root, 'graph.txt'), 'utf8');
  assert.match(tree, /on-chain {2}testnet \(not checked\)/, 'the tree says the check did not run');
  assert.doesNotMatch(tree, /in sync/, 'and never claims a match it did not verify');

  const briefing = await captureOut(() => runResume({ cwd: root }));
  assert.match(briefing, /not checked — no on-chain hash to compare/);
  assert.doesNotMatch(briefing, /matches local build/);

  const deployment = memory.nodes.find((n) => n.kind === 'deployment');
  assert.ok(deployment, 'the demo is deployed somewhere, or this proves nothing');
  const body = noteBody({ ...deployment, data: { ...deployment.data, drift: 'unknown' } });
  assert.match(body, /\*\*Drift:\*\* not checked/, 'the note says so too, rather than nothing');
  assert.doesNotMatch(body, /matches the local build/);
});

test('a deployment carrying no drift at all is unchecked, not in sync', () => {
  // An offline scan records the deployment and never writes the field. Absence
  // is the same claim as `unknown`, said by omission.
  assert.equal(driftState(undefined), 'unknown');
  assert.equal(driftState('in-sync'), 'in-sync');
  assert.equal(driftState('stale'), 'stale');
});

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

test('searching for "storage" finds the storage keys', () => {
  // A storage node carries the word nowhere — not in `DataKey::Admin
  // (instance)`, not in its path, not in its data — while every function with an
  // auth subject serialised `"origin":"storage"`. The most obvious query for a
  // storage key returned every function and not one key.
  const hits = search(memory, 'storage', memory.nodes.length);
  const keys = memory.nodes.filter((n) => n.kind === 'storage').map((n) => n.id);

  assert.deepEqual(
    hits.filter((h) => h.node.kind === 'storage').map((h) => h.node.id).sort(),
    [...keys].sort(),
    'every storage key answers a search for storage',
  );
  assert.equal(hits[0]?.node.kind, 'storage', 'and one of them is the best answer');

  // Ranking, not filtering. `search_memory` has a `kind` argument for narrowing
  // to one kind; a function whose admin address is loaded from storage is still
  // a real answer to this question and must not be dropped by the text search.
  assert.ok(
    hits.some((h) => h.node.kind === 'function'),
    'the kind filter narrows results — the query only orders them',
  );
});

test('a field name in the schema is not a match', () => {
  // `JSON.stringify(data)` put the key `"params"` into every function's
  // searchable text, so a search for the auth shape that lets anyone claim admin
  // returned all thirteen functions, getters included.
  const ids = search(memory, 'param', memory.nodes.length).map((h) => h.node.id);

  assert.ok(
    ids.includes('function:EmployeeRegistry.initialize'),
    'the initializer does authorize a caller-supplied parameter',
  );
  assert.ok(
    !ids.includes('function:EmployeeRegistry.salary_of'),
    'a getter that takes no auth parameter is not an answer about one',
  );
});

/* ------------------------------------------------------------------ *
 * Age
 * ------------------------------------------------------------------ */

test('eleven and a half months ago is not today', () => {
  // Months were counted in 30-day units and years in 365, and the two did not
  // meet: 360 to 364 days matched neither branch and fell through to `0 years
  // ago`. That is the first line of `resume`, the line someone reads to find out
  // how stale their memory of the project is.
  const now = '2026-08-06T12:00:00.000Z';
  const daysAgo = (days: number) =>
    new Date(Date.parse(now) - days * 86_400_000).toISOString();

  assert.equal(humanAge(daysAgo(0), now), 'today');
  assert.equal(humanAge(daysAgo(1), now), 'yesterday');
  assert.equal(humanAge(daysAgo(29), now), '29 days ago');
  assert.equal(humanAge(daysAgo(45), now), 'a month ago');
  assert.equal(humanAge(daysAgo(359), now), '11 months ago');
  assert.equal(humanAge(daysAgo(360), now), 'a year ago');
  assert.equal(humanAge(daysAgo(362), now), 'a year ago');
  assert.equal(humanAge(daysAgo(364), now), 'a year ago');
  assert.equal(humanAge(daysAgo(365), now), 'a year ago');
  assert.equal(humanAge(daysAgo(800), now), '2 years ago');
});
