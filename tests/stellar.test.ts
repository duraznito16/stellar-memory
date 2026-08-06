/**
 * The bridge to the `stellar` CLI, and what it is allowed to claim.
 *
 * Two rules hold this file together. The bridge is read-only: it asks the
 * network questions and never changes anything. And it is optional: when the
 * CLI is missing, slow or angry, a scan still finishes with a full source-level
 * memory. Optional means degrading — not throwing, and not inventing a
 * diagnosis.
 *
 * Each test below is one way the bridge was found to break one of those. A
 * timeout reported as an uninstalled CLI, for the rest of a server's life. A
 * spec that omitted its empty arrays and took the scan down with it. An
 * environment variable set to the empty string that quietly hid every global
 * alias.
 *
 * Against `src`, not `dist`: none of this needs a build to be true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import * as path from 'node:path';

register('./src-specifiers.mjs', import.meta.url);

const {
  aliasDirectories,
  cliUnavailableWarning,
  probeStellarCli,
  resetCliProbe,
  runStellar,
} = await import('../src/stellar/cli.ts');
const { formatSignature, parseSpec } = await import('../src/stellar/spec.ts');

type RunResult = Awaited<ReturnType<typeof runStellar>>;

const OK: RunResult = { ok: true, stdout: 'stellar 23.2.1 (496ac35)\nstellar-xdr 23.0.0\n', stderr: '' };
const ENOENT: RunResult = {
  ok: false,
  stdout: '',
  stderr: '',
  spawnError: 'stellar CLI not found on PATH',
};
const TIMED_OUT: RunResult = { ok: false, stdout: '', stderr: '', timedOut: true };

/** A runner that hands back canned results and counts how often it was asked. */
function scripted(...results: RunResult[]) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args);
    return results[Math.min(calls.length - 1, results.length - 1)]!;
  };
  return { run, calls };
}

/* ------------------------------------------------------------------ *
 * The version probe
 * ------------------------------------------------------------------ */

test('a slow first call is not remembered as an uninstalled CLI', async () => {
  // `stellarVersion` collapsed ENOENT and every other failure into null, and
  // the scanner turned that null into "not found on PATH". A cold disk or an
  // antivirus scanning a fresh binary is enough to blow through the ten second
  // timeout, and the result was cached in module state — so one slow read at
  // startup made a long-lived MCP server skip the on-chain half, and misreport
  // why, for as long as it ran.
  resetCliProbe();
  const { run, calls } = scripted(TIMED_OUT, OK);

  const first = await probeStellarCli(run);
  assert.equal(first.version, null);
  assert.equal(first.missing, false, 'a timeout says nothing about whether the CLI exists');

  const warning = cliUnavailableWarning(first);
  assert.ok(
    !warning.includes('not found on PATH'),
    `a timeout must not be reported as a missing binary: ${warning}`,
  );
  assert.match(warning, /no on-chain data was collected/);

  // And the failure is not cached: the very next ask spawns again and recovers.
  const second = await probeStellarCli(run);
  assert.equal(calls.length, 2, 'the transient failure should have been retried');
  assert.equal(second.version, 'stellar 23.2.1 (496ac35)');

  // Once it answered, that is settled and worth keeping.
  await probeStellarCli(run);
  assert.equal(calls.length, 2, 'a known version is cached');
  resetCliProbe();
});

test('a genuinely missing binary is named as such, once', async () => {
  resetCliProbe();
  const { run, calls } = scripted(ENOENT);

  const probe = await probeStellarCli(run);
  assert.equal(probe.missing, true);
  assert.equal(
    cliUnavailableWarning(probe),
    'The `stellar` CLI was not found on PATH, so no on-chain data was collected.',
  );

  await probeStellarCli(run);
  assert.equal(calls.length, 1, 'ENOENT is a settled fact; do not re-spawn for it');
  resetCliProbe();
});

test('concurrent callers share one spawn', async () => {
  // The scanner and the MCP server can both ask at once. Caching the result
  // rather than the in-flight promise let two probes race.
  resetCliProbe();
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 10));
    return OK;
  };

  const [a, b] = await Promise.all([probeStellarCli(run), probeStellarCli(run)]);
  assert.equal(calls.length, 1, 'one probe, not two');
  assert.equal(a.version, b.version);
  resetCliProbe();
});

test('the probe only ever asks for a version', async () => {
  // The read-only boundary: this bridge inspects, it never signs, deploys or
  // spends. `--version` does not even reach the network.
  resetCliProbe();
  const { run, calls } = scripted(OK);
  await probeStellarCli(run);
  assert.deepEqual(calls, [['--version']]);
  resetCliProbe();
});

/* ------------------------------------------------------------------ *
 * Spec parsing
 * ------------------------------------------------------------------ */

test('a spec that omits its empty arrays does not take the scan down', () => {
  // Real CLI output carries `"inputs": []` for a niladic function, but nothing
  // guarantees it: `e.function_v0 as SpecFunction` was a promise, not a check.
  // One spec without it made `fn.inputs.map` throw a TypeError while rendering
  // a deployment note — outside the try/catch in `fetchInterface`, so the whole
  // scan died instead of degrading to "no interface".
  const spec = parseSpec([
    { function_v0: { name: 'get_metrics', outputs: [{ udt: { name: 'Metrics' } }] } },
    { function_v0: { name: 'init', inputs: [{ name: 'bot', type_: 'address' }] } },
    { event_v0: { name: 'SharpeChanged' } },
    { udt_error_enum_v0: { name: 'OracleError' } },
  ]);

  assert.deepEqual(spec.functions.map((f) => f.inputs), [[], [{ name: 'bot', type_: 'address' }]]);
  assert.deepEqual(spec.functions[0]!.outputs.length, 1);
  assert.deepEqual(spec.functions[1]!.outputs, []);
  assert.deepEqual(spec.events[0]!.params, []);
  assert.deepEqual(spec.events[0]!.prefix_topics, []);

  assert.equal(formatSignature(spec.functions[0]!), 'get_metrics() -> Metrics');
  assert.equal(formatSignature(spec.functions[1]!), 'init(bot: address)');

  // The error enum's cases are read with `?.length` downstream, so absent is
  // fine — present and corrupt must read as absent, not as an array to map.
  assert.equal(spec.errors[0]!.cases, undefined);
});

test('formatSignature survives a spec it did not parse itself', () => {
  // It is exported, so a stored interface or a fixture reaches it directly.
  // `outputs` had a `?? []`; `inputs` had nothing.
  const bare = { name: 'transfer' } as unknown as Parameters<typeof formatSignature>[0];
  assert.equal(formatSignature(bare), 'transfer()');

  const wrong = { name: 'balance', inputs: 'nope', outputs: null } as unknown as Parameters<
    typeof formatSignature
  >[0];
  assert.equal(formatSignature(wrong), 'balance()');
});

test('garbage entries are skipped, not pushed as functions', () => {
  const spec = parseSpec([null, 'nonsense', { function_v0: {} }, { function_v0: { name: 'ok' } }, 42]);
  assert.deepEqual(spec.functions.map((f) => f.name), ['ok']);
  assert.equal(parseSpec('not an array').functions.length, 0);
});

/* ------------------------------------------------------------------ *
 * Where aliases are looked for
 * ------------------------------------------------------------------ */

test('an empty XDG_CONFIG_HOME does not turn the global alias store into a relative path', () => {
  // Minimal Docker images and some CI runners export `XDG_CONFIG_HOME=`. `??`
  // keeps the empty string, so the global directory became the relative
  // `stellar/contract-ids`, resolved against whatever the cwd happened to be.
  // `readAliasDir` swallows the resulting ENOENT, so every global alias
  // disappeared without one word of warning.
  const original = process.env.XDG_CONFIG_HOME;
  try {
    for (const bogus of ['', '   ', 'relative/config']) {
      process.env.XDG_CONFIG_HOME = bogus;
      const dirs = aliasDirectories('/project');
      const global = dirs[dirs.length - 1]!;
      assert.ok(
        path.isAbsolute(global),
        `XDG_CONFIG_HOME=${JSON.stringify(bogus)} produced a relative alias dir: ${global}`,
      );
      assert.match(global, /stellar[\\/]contract-ids$/);
    }

    // A real one is still honoured.
    const real = path.resolve('/tmp/xdg');
    process.env.XDG_CONFIG_HOME = real;
    assert.equal(
      aliasDirectories()[0],
      path.join(real, 'stellar', 'contract-ids'),
    );
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  }
});

test('the project-local alias store is consulted before the global one', () => {
  const dirs = aliasDirectories(path.resolve('/project'));
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0], path.join(path.resolve('/project'), '.stellar', 'contract-ids'));
});
