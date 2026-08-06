/**
 * A thin, honest bridge to the `stellar` CLI.
 *
 * Every call here is read-only: interfaces, hashes, metadata, aliases. The tool
 * inspects a project's relationship with the network; it never signs, deploys,
 * or spends. That boundary is deliberate and worth keeping.
 *
 * The bridge is also entirely optional. When the CLI is absent or the machine is
 * offline, a scan still produces a full source-level memory — it simply lacks
 * the on-chain half.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParsedSpec } from './spec.js';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError?: string;
  /** The process did start, but was killed when the timeout expired. */
  timedOut?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunOptions {
  timeoutMs?: number;
  /** Extra environment for this call, e.g. STELLAR_NETWORK. */
  env?: Record<string, string>;
}

export function runStellar(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, env } = options;
  return new Promise((resolve) => {
    execFile(
      'stellar',
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err && err.code === 'ENOENT') {
          resolve({ ok: false, stdout: '', stderr: '', spawnError: 'stellar CLI not found on PATH' });
          return;
        }
        resolve({
          ok: !error,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          spawnError: undefined,
          // Node kills the child at the timeout; that reads very differently
          // from a CLI that answered and said no.
          timedOut: err?.killed === true ? true : undefined,
        });
      },
    );
  });
}

const PROBE_TIMEOUT_MS = 10_000;

export interface CliProbe {
  /** First line of `stellar --version`, or null when we could not read one. */
  version: string | null;
  /** True only for ENOENT: nothing named `stellar` is on PATH. */
  missing: boolean;
  /** Why the probe came back empty, when it did. */
  detail?: string;
}

export type StellarRunner = (args: string[], options?: RunOptions) => Promise<RunResult>;

let probeInFlight: Promise<CliProbe> | null = null;
let lastProbe: CliProbe | null = null;

/**
 * Ask the CLI what it is, once.
 *
 * Two things this deliberately does not do. It does not cache a transient
 * failure: a cold disk, an antivirus scanning a fresh binary, or the first
 * invocation after boot can all blow through the timeout, and the MCP server is
 * a long-lived process — caching that answer would drop the on-chain half for
 * the rest of the process's life over a slow read that already recovered. And
 * it does not flatten "no such binary" into "something went wrong": only ENOENT
 * means the CLI is absent, and only ENOENT should be reported that way.
 *
 * Success and ENOENT are both settled facts and are cached. What is cached is
 * the promise, not the result, so concurrent callers share one spawn.
 */
export function probeStellarCli(run: StellarRunner = runStellar): Promise<CliProbe> {
  if (probeInFlight) return probeInFlight;
  const probe = run(['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
    .then(readProbe, (err: unknown) => ({
      version: null,
      missing: false,
      detail: err instanceof Error ? err.message : 'the probe itself failed',
    }))
    .then((result) => {
      lastProbe = result;
      if (result.version === null && !result.missing) probeInFlight = null;
      return result;
    });
  probeInFlight = probe;
  return probe;
}

function readProbe(res: RunResult): CliProbe {
  if (res.ok) {
    const version = res.stdout.trim().split('\n')[0]?.trim();
    if (version) return { version, missing: false };
    return { version: null, missing: false, detail: '`--version` printed nothing' };
  }
  if (res.spawnError) return { version: null, missing: true, detail: res.spawnError };
  if (res.timedOut) {
    return { version: null, missing: false, detail: `no answer within ${PROBE_TIMEOUT_MS / 1000}s` };
  }
  const firstLine = res.stderr.trim().split('\n')[0]?.trim();
  return {
    version: null,
    missing: false,
    detail: firstLine ? firstLine.slice(0, 120) : '`--version` exited with an error',
  };
}

/** The installed CLI version, or null when the CLI is unavailable. */
export async function stellarVersion(): Promise<string | null> {
  return (await probeStellarCli()).version;
}

/**
 * How to explain a scan that collected nothing on-chain. Says "not found on
 * PATH" only when the binary really was not there; a probe that timed out gets
 * told as the transient thing it is, because the next scan will retry it.
 */
export function cliUnavailableWarning(probe: CliProbe | null = lastProbe): string {
  if (probe && !probe.missing) {
    const why = probe.detail ? ` (${probe.detail})` : '';
    return `The \`stellar\` CLI was found but did not answer \`--version\`${why}, so no on-chain data was collected. That failure was not cached; the next scan tries again.`;
  }
  return 'The `stellar` CLI was not found on PATH, so no on-chain data was collected.';
}

/** Forget the probe: for tests, and for a long-lived process whose PATH changed. */
export function resetCliProbe(): void {
  probeInFlight = null;
  lastProbe = null;
}

export interface ContractRef {
  contractId?: string;
  wasm?: string;
  wasmHash?: string;
  network?: string;
}

function refArgs(ref: ContractRef): string[] {
  const args: string[] = [];
  if (ref.wasm) args.push('--wasm', ref.wasm);
  else if (ref.wasmHash) args.push('--wasm-hash', ref.wasmHash);
  else if (ref.contractId) args.push('--id', ref.contractId);
  // A network is only meaningful when resolving something on-chain.
  if (!ref.wasm && ref.network) args.push('--network', ref.network);
  return args;
}

/** Describes how a piece of on-chain data was obtained, for provenance. */
export function describeCommand(sub: string[], ref: ContractRef): string {
  return ['stellar', ...sub, ...refArgs(ref)].join(' ');
}

/**
 * The contract's real interface: functions, events and user-defined types.
 * Works against a local .wasm, a Wasm hash, or a live contract ID.
 */
export async function fetchInterface(ref: ContractRef): Promise<ParsedSpec | null> {
  const res = await runStellar(['contract', 'info', 'interface', ...refArgs(ref), '--output', 'json']);
  if (!res.ok) return null;
  const json = extractJson(res.stdout);
  if (json === null) return null;
  try {
    return parseSpec(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * A hash, or the one-line reason there is not one.
 *
 * The reason is the point. `stellar contract info hash` was removed from the CLI
 * — 23.2.1 offers `interface`, `meta`, `env-meta` and `build`, and nothing else
 * — so every call for a Wasm hash had been failing, returning null, and taking
 * drift detection down with it without printing a word. A check that cannot run
 * has to say so; silence reads exactly like a check that ran and found nothing.
 */
export interface WasmHash {
  hash: string | null;
  /** Set only when `hash` is null: why the hash could not be read. */
  detail?: string;
}

/**
 * SHA-256 of a built `.wasm` sitting in the tree.
 *
 * A Soroban contract's on-chain identity *is* the SHA-256 of its Wasm bytes, so
 * this needs no CLI and no network: the local half of drift detection now works
 * for a developer who is offline, and for one who never installed the CLI.
 */
export async function hashLocalWasm(absPath: string): Promise<WasmHash> {
  try {
    const digest = createHash('sha256');
    // Streamed rather than read whole: a Wasm with debug info is measured in
    // megabytes, and a scan hashes one per contract crate.
    for await (const chunk of createReadStream(absPath)) digest.update(chunk as Buffer);
    return { hash: digest.digest('hex') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      hash: null,
      detail: code === 'ENOENT' ? 'no built Wasm at that path' : `could not read it (${code ?? 'unknown error'})`,
    };
  }
}

const FETCH_TIMEOUT_MS = 60_000;

/**
 * SHA-256 of the Wasm a live contract is actually running.
 *
 * `contract fetch` downloads the deployed binary, which is read-only in the
 * strictest sense: it signs nothing, submits nothing and spends nothing. The
 * bytes go to a temporary file rather than through stdout, because a Wasm is
 * large and binary and neither of those belongs in a captured pipe, and the file
 * is deleted as soon as it has been hashed.
 *
 * Fails by design against a Stellar Asset Contract, which is live but has no
 * downloadable code binary. That is a fact about the contract, not a fault, and
 * the caller is told which it got.
 */
export async function fetchOnChainWasmHash(
  ref: ContractRef,
  run: StellarRunner = runStellar,
): Promise<WasmHash> {
  if (!ref.contractId && !ref.wasmHash) return { hash: null, detail: 'no contract id to fetch' };

  let dir: string | undefined;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-wasm-'));
    const out = path.join(dir, 'fetched.wasm');
    const args = ['contract', 'fetch'];
    if (ref.contractId) args.push('--id', ref.contractId);
    else if (ref.wasmHash) args.push('--wasm-hash', ref.wasmHash);
    if (ref.network) args.push('--network', ref.network);
    args.push('--out-file', out);

    const res = await run(args, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!res.ok) return { hash: null, detail: failureDetail(res) };
    const local = await hashLocalWasm(out);
    if (local.hash) return local;
    return { hash: null, detail: '`contract fetch` exited cleanly but left nothing to read' };
  } catch (err) {
    return { hash: null, detail: err instanceof Error ? err.message : 'the fetch itself failed' };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One line explaining a run that did not succeed, for a warning a human reads. */
function failureDetail(res: RunResult): string {
  if (res.spawnError) return res.spawnError;
  if (res.timedOut) return `no answer within ${FETCH_TIMEOUT_MS / 1000}s`;
  const line = res.stderr
    .split('\n')
    // The CLI prefixes errors with an emoji. Only non-ASCII is stripped, so a
    // message that genuinely begins with punctuation — `--network is required`
    // — keeps the part that tells the reader what to do.
    .map((l) => l.trim().replace(/^[^\x20-\x7E]+\s*/u, ''))
    .find((l) => l.length > 0);
  return line ? line.slice(0, 160) : 'the command exited with an error';
}

/**
 * Contract metadata: SDK and compiler versions, plus any custom key/value pairs
 * the author set. Useful for "which SDK was this built against?" months later.
 */
export async function fetchMeta(ref: ContractRef): Promise<Record<string, string> | null> {
  const res = await runStellar(['contract', 'info', 'meta', ...refArgs(ref), '--output', 'json']);
  if (!res.ok) return null;
  const json = extractJson(res.stdout);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    return flattenMeta(parsed);
  } catch {
    return null;
  }
}

/**
 * Which store an alias came out of.
 *
 * This is not bookkeeping — it decides whether the alias is evidence about *this*
 * project. `.stellar/contract-ids` belongs to the project and everything in it
 * was registered from inside it. The global store is one shared list for every
 * Stellar project on the machine, so an entry there says nothing on its own
 * about which project it belongs to. `cli` is what `alias ls` prints: it merges
 * both stores into one stream with no way to tell them apart, so an alias only
 * ever seen there has an origin we do not know.
 */
export type AliasSource = 'project' | 'global' | 'cli';

export interface AliasEntry {
  alias: string;
  contractId: string;
  network: string;
  source: AliasSource;
}

/** Most specific origin wins when the same alias is seen more than once. */
const SOURCE_RANK: Record<AliasSource, number> = { project: 3, global: 2, cli: 1 };

/**
 * Contract aliases registered for a network. These are the link between a name a
 * developer uses and an address on chain, and they are the main reason the tool
 * can say "Treasury is deployed at C… on testnet" without being told.
 */
export async function listAliases(network: string, cwd?: string): Promise<AliasEntry[]> {
  const found = new Map<string, AliasEntry>();
  const add = (entry: AliasEntry) => {
    if (entry.network !== network) return;
    const key = `${entry.alias}:${entry.contractId}`;
    const prev = found.get(key);
    // An alias in both stores is the project's: the ambiguous sighting must not
    // overwrite the one that knows where it lives.
    if (prev && SOURCE_RANK[prev.source] >= SOURCE_RANK[entry.source]) return;
    found.set(key, entry);
  };

  // `alias ls` takes no --network flag, so scope it through the environment.
  // Verified empirically: it prints the same entries whatever STELLAR_NETWORK
  // says, so the network on a CLI-derived entry is a hint, not evidence. Only
  // the alias files below key ids by passphrase and can be trusted on that
  // point — which is why a deployment is not recorded until the network itself
  // answers something about the contract.
  const res = await runStellar(['contract', 'alias', 'ls'], { env: { STELLAR_NETWORK: network } });
  if (res.ok) {
    // One `alias: CONTRACT_ID` per line, preceded by an informational line.
    // Run inside a project the output is two such blocks, the local store then
    // the global one, with nothing in the text marking the boundary — hence
    // `source: 'cli'`, and hence the file walk below, which does know.
    for (const line of res.stdout.split('\n')) {
      const m = /^\s*([\w.-]+)\s*:\s*(C[A-Z2-7]{55})\s*$/.exec(line);
      if (m?.[1] && m[2]) add({ alias: m[1], contractId: m[2], network, source: 'cli' });
    }
  }

  // Read the alias files directly too. They key contract IDs by network
  // passphrase, which is the only source that distinguishes networks reliably —
  // and a project cloned onto a fresh machine carries its own copies.
  for (const { dir, source } of aliasStores(cwd)) {
    for (const entry of await readAliasDir(dir, network, source)) add(entry);
  }

  return [...found.values()];
}

export interface AliasStore {
  dir: string;
  source: AliasSource;
}

/**
 * Both the project-local store and the CLI's global config directory, each
 * labelled with what finding an alias there proves.
 */
export function aliasStores(cwd?: string): AliasStore[] {
  const dirs: AliasStore[] = [];
  if (cwd) dirs.push({ dir: path.join(cwd, '.stellar', 'contract-ids'), source: 'project' });

  // `??` would keep an empty XDG_CONFIG_HOME, and minimal Docker images and
  // some CI runners do export it empty. That turned the global alias store into
  // the relative path `stellar/contract-ids`, resolved against whatever the
  // process's cwd happened to be — where readAliasDir swallowed the ENOENT and
  // every global alias vanished without a word. Anything that is not an
  // absolute path is not a config home.
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  dirs.push({ dir: path.join(configHome, 'stellar', 'contract-ids'), source: 'global' });
  return dirs;
}

/**
 * Just the paths consulted, in order. Which directories were read is the whole
 * answer to "why did it not see my alias?", and that deserves to be testable.
 */
export function aliasDirectories(cwd?: string): string[] {
  return aliasStores(cwd).map((store) => store.dir);
}

async function readAliasDir(
  dir: string,
  fallbackNetwork: string,
  source: AliasSource,
): Promise<AliasEntry[]> {
  const out: AliasEntry[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out; // directory simply does not exist
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as { ids?: Record<string, string> };
      const alias = name.replace(/\.json$/, '');
      for (const [passphrase, id] of Object.entries(parsed.ids ?? {})) {
        if (typeof id !== 'string') continue;
        out.push({
          alias,
          contractId: id,
          network: guessNetwork(passphrase, fallbackNetwork),
          source,
        });
      }
    } catch {
      // skip unreadable alias files
    }
  }
  return out;
}

/** Alias files key ids by network passphrase; map the well-known ones back to names. */
function guessNetwork(passphrase: string, fallback: string): string {
  if (/Test SDF Network/i.test(passphrase)) return 'testnet';
  if (/Public Global Stellar Network/i.test(passphrase)) return 'mainnet';
  if (/Test SDF Future Network/i.test(passphrase)) return 'futurenet';
  if (/Standalone Network/i.test(passphrase)) return 'local';
  return passphrase || fallback;
}

/** Networks the CLI knows about, for scoping a scan. */
export async function listNetworks(): Promise<string[]> {
  const res = await runStellar(['network', 'ls']);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w-]+$/.test(l));
}

/* ------------------------------------------------------------------ */

/**
 * The CLI prints progress lines to stdout before the payload, so take the JSON
 * document rather than assuming the whole stream is JSON.
 */
function extractJson(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const opener = trimmed[start];
  const closer = opener === '[' ? ']' : '}';
  const end = trimmed.lastIndexOf(closer);
  if (end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function flattenMeta(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    // Meta entries arrive as { sc_meta_v0: { key, val } }.
    const inner = rec.sc_meta_v0 ?? rec;
    const i = inner as Record<string, unknown>;
    if (typeof i.key === 'string' && typeof i.val === 'string') {
      out[i.key] = i.val;
      return;
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(parsed);
  return out;
}
