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

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { register } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

register('./src-specifiers.mjs', import.meta.url);

const {
  aliasDirectories,
  cliUnavailableWarning,
  fetchOnChainWasmHash,
  hashLocalWasm,
  listAliases,
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
 * Wasm hashes, which are the whole of drift detection
 * ------------------------------------------------------------------ */

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-cli-'));
  temps.push(dir);
  return dir;
}

test('the local half of a drift check is bytes on disk, not a CLI subcommand', async () => {
  // It used to be `stellar contract info hash --wasm <file>`. That subcommand
  // was removed — 23.2.1 offers interface, meta, env-meta and build, and
  // nothing else — so the call had been failing and returning null for every
  // contract, on every scan, without a word. A Soroban contract's identity is
  // the SHA-256 of its Wasm bytes, so there is no reason to ask anyone: this now
  // works with no CLI installed and no network in reach.
  const dir = await tempDir();
  const wasm = path.join(dir, 'treasury.wasm');
  const bytes = Buffer.from('\0asm\x01\x00\x00\x00not really a module');
  await fs.writeFile(wasm, bytes);

  const { hash } = await hashLocalWasm(wasm);
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'));

  // And a missing artifact is a reason, not a shrug.
  const absent = await hashLocalWasm(path.join(dir, 'never-built.wasm'));
  assert.equal(absent.hash, null);
  assert.match(absent.detail ?? '', /no built Wasm/);
});

test('the deployed half is fetched, hashed and cleaned up — and never asks for `info hash`', async () => {
  const bytes = Buffer.from('\0asm\x01\x00\x00\x00deployed build');
  const calls: string[][] = [];
  let wrote = '';

  // The CLI writes the binary; stand in for it exactly, so what is asserted is
  // the shape of the real invocation and not a paraphrase of it.
  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args);
    wrote = args[args.indexOf('--out-file') + 1] ?? '';
    await fs.writeFile(wrote, bytes);
    return { ok: true, stdout: '', stderr: '' };
  };

  const res = await fetchOnChainWasmHash(
    { contractId: 'CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R', network: 'testnet' },
    run,
  );
  assert.equal(res.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(res.detail, undefined);

  assert.deepEqual(calls[0]?.slice(0, 6), [
    'contract',
    'fetch',
    '--id',
    'CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R',
    '--network',
    'testnet',
  ]);
  assert.equal(calls[0]?.[6], '--out-file', 'a Wasm is large and binary; it goes to a file, not a pipe');
  assert.ok(
    !calls.some((args) => args.join(' ').includes('info hash')),
    'nothing may call a subcommand the CLI does not have',
  );
  assert.ok(!existsSync(wrote), `the downloaded binary is temporary and was left behind at ${wrote}`);

  // `contract fetch` reads. The boundary is that this bridge never writes to the
  // network, and a hash check is exactly the kind of thing that gets "improved"
  // into a redeploy.
  for (const args of calls) {
    assert.ok(
      !/^(deploy|invoke|install|upgrade|restore|extend|send|sign)$/.test(args[1] ?? ''),
      `read-only bridge issued \`stellar ${args.join(' ')}\``,
    );
  }
});

test('a hash that could not be read comes back with the reason it could not', async () => {
  // Silence is the actual defect. `fetchWasmHash` returned null whether the
  // contract was a Stellar Asset Contract with no code to download, the network
  // was unreachable, or the subcommand did not exist — and the scan turned all
  // three into `drift: "unknown"` with nothing printed, so a `check --fail-on
  // drift` gate passed because nothing had been checked.
  const sac = await fetchOnChainWasmHash({ contractId: 'CDLZ...', network: 'testnet' }, async () => ({
    ok: false,
    stdout: '',
    stderr:
      '❌ error: cannot fetch wasm for contract because the contract is a network built-in asset contract that does not have a downloadable code binary\n',
  }));
  assert.equal(sac.hash, null);
  assert.match(sac.detail ?? '', /built-in asset contract/);
  assert.doesNotMatch(sac.detail ?? '', /^❌/, 'the reason is for a human to read in a warning');

  const timedOut = await fetchOnChainWasmHash({ contractId: 'CDLZ...' }, async () => ({
    ok: false,
    stdout: '',
    stderr: '',
    timedOut: true,
  }));
  assert.match(timedOut.detail ?? '', /no answer within/);

  const missing = await fetchOnChainWasmHash({ contractId: 'CDLZ...' }, async () => ({
    ok: false,
    stdout: '',
    stderr: '',
    spawnError: 'stellar CLI not found on PATH',
  }));
  assert.match(missing.detail ?? '', /not found on PATH/);

  // Nothing to ask about is also a reason, and asking anyway would have spawned
  // a process to be told so.
  assert.match((await fetchOnChainWasmHash({})).detail ?? '', /no contract id/);
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

test('an alias remembers which store it came out of', async () => {
  // The global store is one list shared by every Stellar project on the
  // machine, so an address in it says nothing about which project it belongs
  // to. Without that distinction the scanner could not tell a dependency the
  // project really uses from someone else's unrelated contract, and pulled
  // three strangers into the demo's memory as its own deployments.
  const home = await tempDir();
  const project = await tempDir();
  const passphrase = 'Test SDF Network ; September 2015';

  const write = async (dir: string, alias: string, id: string) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${alias}.json`), JSON.stringify({ ids: { [passphrase]: id } }));
  };
  const globalDir = path.join(home, 'stellar', 'contract-ids');
  await write(globalDir, 'strategy-vault', 'CA6EEG6X36QTEOJVJ5KOU5UQR4ZUTG7HPZJ54SXNWQTPJMVTTCILAR4P');
  await write(globalDir, 'treasury', 'CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R');
  const projectDir = path.join(project, '.stellar', 'contract-ids');
  await write(projectDir, 'pay-token', 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
  // The same alias in both stores: the project knows where it lives, so the
  // ambiguous copy must not overwrite it.
  await write(projectDir, 'treasury', 'CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R');

  const original = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    const aliases = await listAliases('testnet', project);
    const by = (name: string) => aliases.find((a) => a.alias === name);
    assert.equal(by('pay-token')?.source, 'project');
    assert.equal(by('strategy-vault')?.source, 'global');
    assert.equal(by('treasury')?.source, 'project');
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  }
});
