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
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParsedSpec } from './spec.js';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError?: string;
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
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, stdout: '', stderr: '', spawnError: 'stellar CLI not found on PATH' });
          return;
        }
        resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '', spawnError: undefined });
      },
    );
  });
}

let cachedVersion: string | null | undefined;

/** The installed CLI version, or null when the CLI is unavailable. */
export async function stellarVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion;
  const res = await runStellar(['--version'], { timeoutMs: 10_000 });
  cachedVersion = res.ok ? res.stdout.trim().split('\n')[0] ?? null : null;
  return cachedVersion;
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

/** SHA-256 of the contract's Wasm. Comparing local against on-chain reveals drift. */
export async function fetchWasmHash(ref: ContractRef): Promise<string | null> {
  const res = await runStellar(['contract', 'info', 'hash', ...refArgs(ref)]);
  if (!res.ok) return null;
  const match = /\b([0-9a-f]{64})\b/i.exec(res.stdout);
  return match?.[1]?.toLowerCase() ?? null;
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

export interface AliasEntry {
  alias: string;
  contractId: string;
  network: string;
}

/**
 * Contract aliases registered for a network. These are the link between a name a
 * developer uses and an address on chain, and they are the main reason the tool
 * can say "Treasury is deployed at C… on testnet" without being told.
 */
export async function listAliases(network: string, cwd?: string): Promise<AliasEntry[]> {
  const found = new Map<string, AliasEntry>();
  const add = (entry: AliasEntry) => {
    if (entry.network === network) found.set(`${entry.alias}:${entry.contractId}`, entry);
  };

  // `alias ls` takes no --network flag; it reports whichever network the CLI is
  // currently pointed at, so scope it through the environment instead.
  const res = await runStellar(['contract', 'alias', 'ls'], { env: { STELLAR_NETWORK: network } });
  if (res.ok) {
    // One `alias: CONTRACT_ID` per line, preceded by an informational line.
    for (const line of res.stdout.split('\n')) {
      const m = /^\s*([\w.-]+)\s*:\s*(C[A-Z2-7]{55})\s*$/.exec(line);
      if (m?.[1] && m[2]) add({ alias: m[1], contractId: m[2], network });
    }
  }

  // Read the alias files directly too. They key contract IDs by network
  // passphrase, which is the only source that distinguishes networks reliably —
  // and a project cloned onto a fresh machine carries its own copies.
  for (const dir of aliasDirectories(cwd)) {
    for (const entry of await readAliasDir(dir, network)) add(entry);
  }

  return [...found.values()];
}

/** Both the project-local store and the CLI's global config directory. */
function aliasDirectories(cwd?: string): string[] {
  const dirs: string[] = [];
  if (cwd) dirs.push(path.join(cwd, '.stellar', 'contract-ids'));

  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  dirs.push(path.join(configHome, 'stellar', 'contract-ids'));
  return dirs;
}

async function readAliasDir(dir: string, fallbackNetwork: string): Promise<AliasEntry[]> {
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
        out.push({ alias, contractId: id, network: guessNetwork(passphrase, fallbackNetwork) });
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
