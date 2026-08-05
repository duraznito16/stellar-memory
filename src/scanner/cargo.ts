/**
 * Cargo manifest reading.
 *
 * Tells us which crates exist, which of them are Soroban contracts (they depend
 * on `soroban-sdk` and build a cdylib), and how they depend on one another.
 */

import { parse as parseToml } from 'smol-toml';

export interface CrateManifest {
  /** Repo-relative path of the Cargo.toml. */
  rel: string;
  /** Directory containing the manifest, repo-relative. */
  dir: string;
  name?: string;
  version?: string;
  description?: string;
  /** Workspace member globs, when this manifest defines a workspace. */
  members: string[];
  /** Dependency names, merged across [dependencies] and [dev-dependencies]. */
  dependencies: string[];
  devDependencies: string[];
  /** True when `crate-type` includes cdylib — how a Soroban contract is built. */
  isCdylib: boolean;
  /** True when soroban-sdk is a dependency. */
  usesSorobanSdk: boolean;
  /** Version requirement declared for soroban-sdk, when present. */
  sorobanSdkVersion?: string;
}

export function parseCargoToml(rel: string, source: string): CrateManifest | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(source) as Record<string, unknown>;
  } catch {
    return null; // a malformed manifest is the project's problem, not a scan failure
  }

  const dir = rel.replace(/\/?Cargo\.toml$/, '') || '.';
  const pkg = asRecord(doc.package);
  const workspace = asRecord(doc.workspace);
  const lib = asRecord(doc.lib);

  const dependencies = dependencyNames(doc.dependencies);
  const devDependencies = dependencyNames(doc['dev-dependencies']);

  const crateType = lib?.['crate-type'];
  const isCdylib = Array.isArray(crateType) && crateType.some((t) => t === 'cdylib');

  const all = [...dependencies, ...devDependencies];
  const usesSorobanSdk = all.includes('soroban-sdk');

  return {
    rel,
    dir,
    name: typeof pkg?.name === 'string' ? pkg.name : undefined,
    version: versionOf(pkg?.version),
    description: typeof pkg?.description === 'string' ? pkg.description : undefined,
    members: workspaceMembers(workspace),
    dependencies,
    devDependencies,
    isCdylib,
    usesSorobanSdk,
    sorobanSdkVersion: sorobanVersion(doc.dependencies) ?? sorobanVersion(doc['dev-dependencies']),
  };
}

/**
 * Whether this crate is a deployable Soroban contract, as opposed to a shared
 * library or a workspace root. Requiring both the SDK and a cdylib target is
 * what distinguishes the two.
 */
export function isContractCrate(manifest: CrateManifest): boolean {
  return manifest.usesSorobanSdk && manifest.isCdylib;
}

/**
 * The conventional Wasm output path for a crate, relative to the workspace root.
 * Cargo replaces hyphens with underscores in artifact names.
 */
export function wasmArtifactPath(crateName: string): string {
  const artifact = crateName.replace(/-/g, '_');
  return `target/wasm32v1-none/release/${artifact}.wasm`;
}

/** Older toolchains emitted to a different target triple; check both. */
export function legacyWasmArtifactPath(crateName: string): string {
  const artifact = crateName.replace(/-/g, '_');
  return `target/wasm32-unknown-unknown/release/${artifact}.wasm`;
}

/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function dependencyNames(section: unknown): string[] {
  const rec = asRecord(section);
  return rec ? Object.keys(rec) : [];
}

function workspaceMembers(workspace: Record<string, unknown> | undefined): string[] {
  const members = workspace?.members;
  return Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string') : [];
}

/** `version` may be a string or `{ workspace = true }`. */
function versionOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const rec = asRecord(value);
  if (rec?.workspace === true) return 'workspace';
  return undefined;
}

function sorobanVersion(section: unknown): string | undefined {
  const rec = asRecord(section);
  const entry = rec?.['soroban-sdk'];
  if (typeof entry === 'string') return entry;
  const inline = asRecord(entry);
  if (typeof inline?.version === 'string') return inline.version;
  if (inline?.workspace === true) return 'workspace';
  return undefined;
}
