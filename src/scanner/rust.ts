/**
 * Soroban-aware Rust analysis.
 *
 * This is a pattern analyser, not a Rust compiler. It targets the macro
 * vocabulary that defines a Soroban contract — `#[contract]`, `#[contractimpl]`,
 * `contractimport!`, `env.storage()`, `env.events()` — which is regular enough
 * to read reliably without a full parse, and which is exactly the structure a
 * developer forgets while away from a project.
 *
 * Comments are stripped before matching so that commented-out code never becomes
 * a fact. String literals are preserved, because storage keys and imported Wasm
 * paths live inside them.
 */

export type StorageDurability = 'instance' | 'persistent' | 'temporary';
export type StorageOp = 'get' | 'try_get' | 'set' | 'has' | 'remove' | 'update' | 'extend_ttl';

/**
 * How a storage method is classified. The method name is captured generically
 * rather than matched against a fixed list: enumerating them meant
 * `extend_ttl_with_limits` matched nothing, so a contract that correctly
 * extends its TTL was reported as one that never does — a false warning about
 * working code.
 */
const STORAGE_OPS: Record<string, StorageOp> = {
  get: 'get',
  try_get: 'try_get',
  has: 'has',
  set: 'set',
  update: 'update',
  remove: 'remove',
  extend_ttl: 'extend_ttl',
  extend_ttl_with_limits: 'extend_ttl',
  extend_ttl_to_max: 'extend_ttl',
  bump: 'extend_ttl',
};

export interface StorageAccess {
  durability: StorageDurability;
  op: StorageOp;
  /**
   * The key expression as written, e.g. `DataKey::Admin`. Absent when the call
   * addresses no single entry — `instance().extend_ttl(threshold, extend_to)`
   * takes ledger numbers, not a key, and reading its first argument as one
   * produced a storage entry named `100`.
   */
  key?: string;
  line: number;
  /**
   * The file this access was actually read from — set whenever the caller
   * supplied a path, which `analyseRustFile` always does.
   *
   * `line` is counted in that file. A helper on line 87 of `balance.rs`, folded
   * into an entry point in a 60-line `lib.rs`, was cited as `lib.rs:87` — a
   * reference to code that is not there, which is worse than no reference at
   * all. Anything emitting provenance for an access must prefer this over the
   * path of the file being analysed.
   */
  file?: string;
}

/**
 * Where the address passed to `require_auth` came from.
 *
 * `guard-macro` covers libraries that move the check out of the body entirely —
 * OpenZeppelin's `#[only_owner]` and `#[only_role(..)]` gate a function through
 * a proc macro, so the body contains no `require_auth` call at all. Reading that
 * as "no authorization" would report audited library code as an open door.
 */
export type AuthOrigin = 'param' | 'storage' | 'current_contract' | 'guard-macro' | 'unknown';

/**
 * Attributes that gate a function on the caller's identity or role.
 *
 * Deliberately excludes `#[when_not_paused]` and similar state guards: those
 * restrict *when* a function may run, not *who* may run it.
 */
const ACCESS_GUARD_ATTRS =
  /^(only_owner|only_admin|only_role|only_any_role|has_role|only_authorized)\b/;

export interface AuthSubject {
  /** The receiver expression as written, e.g. `admin`. */
  expr: string;
  origin: AuthOrigin;
  /** For `storage` origin, the key the address was loaded from. */
  key?: string;
  /** True for `require_auth_for_args`. */
  forArgs: boolean;
}

export interface FunctionDecl {
  name: string;
  line: number;
  params: { name: string; type: string }[];
  returns?: string;
  requiresAuth: boolean;
  /**
   * Whose authority is demanded. `requiresAuth` alone records only THAT auth
   * happened — a function calling `require_auth` on its own caller-supplied
   * parameter restricts nobody, and reporting it as access-controlled is worse
   * than reporting nothing.
   */
  authSubjects: AuthSubject[];
  storage: StorageAccess[];
  /** Topic expressions passed to `env.events().publish(...)`. */
  events: string[];
  /** Contract client types constructed in this body — evidence of cross-contract calls. */
  clientCalls: string[];
  /** The same calls with their target address and the methods invoked on them. */
  contractCalls: ContractCall[];
  /** True when this function calls `update_current_contract_wasm`. */
  upgradesContract: boolean;
  /** Access-control attributes on this function, e.g. `only_owner`. */
  guards: string[];
}

export interface ContractDecl {
  name: string;
  line: number;
  functions: FunctionDecl[];
  /** Trait paths implemented via `impl <Trait> for <Type>`, e.g. `token::TokenInterface`. */
  implementsTraits?: string[];
  /** True when the contract calls `update_current_contract_wasm` — it can be replaced in place. */
  upgradeable?: boolean;
  /** The function that performs the upgrade, when there is one. */
  upgradeFn?: string;
}

/**
 * What kind of contract is on the other end of a client call.
 *
 * `TokenClient` and `StellarAssetClient` come from the SDK rather than from a
 * `contractimport!`, so they never resolve to a crate in the workspace. Dropping
 * them — which is what happened before — meant a contract that moves real money
 * through the SDK token client left no trace in the graph at all.
 */
export type ClientKind = 'generated' | 'token' | 'stellar-asset';

export interface ContractCall {
  /** The client type or module as written, e.g. `treasury`, `Token`. */
  client: string;
  kind: ClientKind;
  /** The address expression passed to `::new`, e.g. `treasury_id`. */
  address?: string;
  /** Where that address came from, resolved the same way auth subjects are. */
  addressOrigin: AuthOrigin;
  /** For a storage-sourced address, the key it was loaded from. */
  addressKey?: string;
  /** Methods invoked on the constructed client. */
  methods: string[];
  line: number;
}

export interface ImportDecl {
  /** The `mod` wrapping the import, when present — usually the callee's name. */
  module?: string;
  /** The `file = "..."` argument: a path to the imported contract's Wasm. */
  wasmFile?: string;
  line: number;
}

export interface NamedDecl {
  name: string;
  line: number;
}

/** One variant of a `#[contracterror]` enum, with its wire discriminant. */
export interface ErrorVariant {
  name: string;
  code: number;
}

export interface ErrorDecl extends NamedDecl {
  variants: ErrorVariant[];
}

export interface RustFileAnalysis {
  rel: string;
  contracts: ContractDecl[];
  /** `#[contracttype]` structs and enums. */
  types: NamedDecl[];
  /** `#[contracterror]` enums, with their variants and discriminants. */
  errors: ErrorDecl[];
  /** `#[contractevent]` structs. */
  events: NamedDecl[];
  imports: ImportDecl[];
  isTest: boolean;
  usesSorobanSdk: boolean;
}

/**
 * A free function defined outside any `#[contractimpl]` block.
 *
 * Real Soroban projects keep storage access and role lookups in helper modules —
 * `balance.rs`, `allowance.rs`, `read_admin()` — which is how the official
 * examples are written. Walking only impl bodies made the entire fund-bearing
 * storage surface of such a contract invisible, and turned every helper-resolved
 * admin into an unknown auth subject.
 */
export interface HelperFn {
  storage: StorageAccess[];
  events: string[];
  clientCalls: string[];
  /** Set when the helper's whole job is to read one storage key and return it. */
  returnsStorageKey?: string;
  /**
   * The file the helper is defined in, when the caller supplied it. Its storage
   * accesses carry the same path, and their line numbers are counted there.
   */
  file?: string;
}

/**
 * The free functions a file exports to the rest of its crate.
 *
 * Rust modules are crate-scoped, so `mod balance;` puts helpers in a sibling
 * file. Collecting them per-file meant a canonical token — whose storage lives
 * in admin.rs, balance.rs and allowance.rs — produced no storage nodes at all,
 * and the `has()` re-initialization guard in a sibling module went unseen,
 * bringing back a false positive on correct code. Callers should gather these
 * across a crate and pass them back in.
 */
export function collectHelpersFrom(source: string, rel?: string): Map<string, HelperFn> {
  const src = stripComments(source);
  return collectFreeFunctions(
    src,
    collectContractImpls(src).map((i) => [i.bodyStart, i.bodyEnd] as [number, number]),
    rel,
  );
}

export function analyseRustFile(
  rel: string,
  source: string,
  crateHelpers?: Map<string, HelperFn>,
): RustFileAnalysis {
  const src = stripComments(source);

  const analysis: RustFileAnalysis = {
    rel,
    contracts: [],
    types: collectAttributed(src, 'contracttype'),
    errors: collectErrorEnums(src),
    events: collectAttributed(src, 'contractevent'),
    imports: collectImports(src),
    isTest: looksLikeTestFile(src, rel),
    usesSorobanSdk: /\bsoroban_sdk\b/.test(src),
  };

  const contractNames = collectContractNames(src);
  const impls = collectContractImpls(src);
  // Helpers defined here win over same-named ones from sibling modules.
  const helpers = new Map(crateHelpers ?? []);
  for (const [name, helper] of collectFreeFunctions(
    src,
    impls.map((i) => [i.bodyStart, i.bodyEnd] as [number, number]),
    rel,
  )) {
    helpers.set(name, helper);
  }

  // A `#[contractimpl]` block is where the public interface lives. Group the
  // impl blocks by the type they implement so partial impls merge into one
  // contract rather than appearing as duplicates.
  const byName = new Map<string, ContractDecl>();
  for (const { name, line } of contractNames) {
    byName.set(name, { name, line, functions: [] });
  }
  for (const impl of impls) {
    let decl = byName.get(impl.typeName);
    if (!decl) {
      // `#[contractimpl]` without a visible `#[contract]` (e.g. split across
      // files). Still worth recording — the interface is the useful part.
      decl = { name: impl.typeName, line: impl.line, functions: [] };
      byName.set(impl.typeName, decl);
    }
    decl.functions.push(
      ...parseImplFunctions(
        src,
        impl.bodyStart,
        impl.bodyEnd,
        impl.traitPath !== undefined,
        helpers,
        rel,
      ),
    );
    if (impl.traitPath) {
      decl.implementsTraits = [...(decl.implementsTraits ?? []), impl.traitPath];
    }
  }

  // Upgradeability gates every other decision about a contract — whether a bug
  // can ever be patched, and whether live state written by older code still has
  // to decode. It is one literal token in one function body.
  for (const decl of byName.values()) {
    const upgrader = decl.functions.find((f) => f.upgradesContract);
    if (upgrader) {
      decl.upgradeable = true;
      decl.upgradeFn = upgrader.name;
    }
  }

  // OpenZeppelin's upgradeable module generates the upgrade entry point from a
  // derive macro, so `update_current_contract_wasm` never appears in the user's
  // source. Reporting such a contract as "not upgradeable" would be a false
  // statement about it — the most damaging kind of error this tool can make.
  for (const derived of collectUpgradeableDerives(src)) {
    const decl = byName.get(derived.name);
    if (!decl) continue;
    decl.upgradeable = true;
    decl.upgradeFn ??= derived.migratable ? 'upgrade (derived, with migrate)' : 'upgrade (derived)';
  }

  analysis.contracts = [...byName.values()].filter(
    (c) => c.functions.length > 0 || contractNames.some((n) => n.name === c.name),
  );

  return analysis;
}

/* ------------------------------------------------------------------ *
 * Lexical helpers
 * ------------------------------------------------------------------ */

/**
 * Replace comments with spaces, leaving every other byte — and therefore every
 * line number and offset — exactly where it was. String literals are skipped
 * over rather than blanked, so a `//` inside a URL is not mistaken for a comment.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Raw string: r"...", r#"..."#, r##"..."##
    if (ch === 'r' && (next === '"' || next === '#')) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') { hashes++; j++; }
      if (src[j] === '"') {
        j++;
        const terminator = '"' + '#'.repeat(hashes);
        const end = src.indexOf(terminator, j);
        i = end === -1 ? n : end + terminator.length;
        continue;
      }
    }

    if (ch === '"') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // Distinguish a char literal from a lifetime: `'a'` closes, `'a` does not.
    if (ch === "'") {
      const closeAt = src[i + 1] === '\\' ? findCharClose(src, i + 2) : (src[i + 2] === "'" ? i + 2 : -1);
      if (closeAt !== -1) {
        i = closeAt + 1;
      } else {
        i++; // a lifetime; nothing to skip
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Rust block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
        if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    i++;
  }

  return out.join('');
}

function findCharClose(src: string, from: number): number {
  return src[from + 1] === "'" ? from + 1 : -1;
}

export function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/** Given the index of an opening brace, return the index just past its match. */
function matchBrace(src: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/* ------------------------------------------------------------------ *
 * Test detection
 * ------------------------------------------------------------------ */

/**
 * Is this file nothing but tests?
 *
 * The distinction between the two spellings of the attribute decides it.
 * `#![cfg(test)]` is an *inner* attribute: it gates everything in the file.
 * `#[cfg(test)] mod tests { … }` is an *outer* attribute gating only that
 * module, and putting it at the foot of a production file is the dominant
 * convention in Rust — so treating any occurrence as "this file is a test"
 * classified a real `balance.rs` as a test module. Its `#[contracttype]`s and
 * `#[contracterror]`s then vanished from the graph and its production code was
 * presented to the developer as a test.
 *
 * The outer form still counts when the module it gates is the entire file,
 * which is how a test-only file that avoids the inner attribute is written.
 */
function looksLikeTestFile(src: string, rel: string): boolean {
  // `tests/` and `test.rs` / `tests.rs` are the conventional locations.
  if (/(^|\/)tests?\//.test(rel) || /(^|\/)_?tests?\.rs$/.test(rel)) return true;
  if (/#!\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(src)) return true;
  return testModuleSpansFile(src);
}

/**
 * True when a `#[cfg(test)] mod … { … }` covers everything the file contains,
 * so the outer attribute happens to gate the whole file after all.
 */
function testModuleSpansFile(src: string): boolean {
  // `#[cfg(test)]` only — the `!` of the inner form is not whitespace, so the
  // two spellings cannot be confused here.
  const re = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const after = src.slice(m.index + m[0].length);
    // A `mod` with a body. `#[cfg(test)] mod test;` declares a *sibling file*
    // as the test module, which says nothing about this one.
    const mod = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*\{/.exec(after);
    if (!mod) continue;

    const braceOpen = m.index + m[0].length + mod[0].length - 1;
    const end = matchBrace(src, braceOpen);
    if (definesNothing(src.slice(0, m.index)) && definesNothing(src.slice(end))) return true;
  }
  return false;
}

/** Whitespace, inner attributes and imports — nothing that declares behaviour. */
function definesNothing(text: string): boolean {
  return !text
    .replace(/#!\s*\[[^\]]*\]/g, ' ')
    .replace(/\b(?:pub(?:\s*\([^)]*\))?\s+)?use\s+[^;]*;/g, ' ')
    .replace(/\bextern\s+crate\s+[^;]*;/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Declaration collection
 * ------------------------------------------------------------------ */

/**
 * An optional path in front of an attribute macro. A crate that skips the
 * prelude writes `#[soroban_sdk::contract]`, and matching only the bare name
 * found no contract, no functions and no types in its main file — the contract
 * disappeared from the graph without a single warning.
 */
const ATTR_PATH = String.raw`(?:\w+\s*::\s*)*`;

function collectContractNames(src: string): NamedDecl[] {
  const out: NamedDecl[] = [];
  // `#[contract]` exactly — not `#[contracttype]`, `#[contractimpl]`, etc. The
  // closing bracket right after the name is what keeps those out.
  const re = new RegExp(
    String.raw`#\[${ATTR_PATH}contract\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out.push({ name: m[1], line: lineAt(src, m.index) });
  }
  return out;
}

/**
 * `#[contracterror]` enums, opened up to their variants.
 *
 * The discriminants are published ABI: a client matches on the integer, and a
 * failed invocation surfaces to the caller as `Error(Contract, #2)`. Recording
 * them means renumbering a variant shows up as a changed node on the next scan,
 * which is the kind of break that is otherwise invisible until an integration
 * starts misreporting failures.
 */
function collectErrorEnums(src: string): ErrorDecl[] {
  const out: ErrorDecl[] = [];
  const re = new RegExp(
    String.raw`#\[${ATTR_PATH}contracterror(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+(\w+)`,
    'g',
  );
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (!name) continue;

    const brace = src.indexOf('{', m.index + m[0].length);
    const variants: ErrorVariant[] = [];
    if (brace !== -1) {
      const body = src.slice(brace + 1, matchBrace(src, brace) - 1);
      // Soroban requires an explicit discriminant on every variant, so a
      // variant without one is not part of the wire contract.
      const variantRe = /(\w+)\s*=\s*(\d+)/g;
      let v: RegExpExecArray | null;
      while ((v = variantRe.exec(body)) !== null) {
        const variantName = v[1];
        const code = Number(v[2]);
        if (variantName && Number.isFinite(code)) variants.push({ name: variantName, code });
      }
    }

    out.push({ name, line: lineAt(src, m.index), variants });
  }
  return out;
}

/**
 * Contract structs carrying `#[derive(Upgradeable)]` or
 * `#[derive(UpgradeableMigratable)]` from OpenZeppelin's `stellar-macros`.
 */
function collectUpgradeableDerives(src: string): { name: string; migratable: boolean }[] {
  const out: { name: string; migratable: boolean }[] = [];
  const re = /#\[derive\(([^)]*)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const derives = m[1] ?? '';
    const name = m[2];
    if (!name) continue;
    const migratable = /\bUpgradeableMigratable\b/.test(derives);
    if (migratable || /\bUpgradeable\b/.test(derives)) out.push({ name, migratable });
  }

  // `#[derive(..)]` may sit above `#[contract]`, in which case the struct is not
  // adjacent to the derive. Fall back to the trait implementation, which is
  // required by both macros.
  const implRe = /impl\s+Upgradeable(?:Migratable)?Internal\s+for\s+(\w+)/g;
  let i: RegExpExecArray | null;
  while ((i = implRe.exec(src)) !== null) {
    const name = i[1];
    if (name && !out.some((o) => o.name === name)) {
      out.push({ name, migratable: /Migratable/.test(i[0]) });
    }
  }

  return out;
}

function collectAttributed(src: string, attr: string): NamedDecl[] {
  const out: NamedDecl[] = [];
  const re = new RegExp(
    String.raw`#\[${ATTR_PATH}${attr}(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?(?:struct|enum)\s+(\w+)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out.push({ name: m[1], line: lineAt(src, m.index) });
  }
  return out;
}

interface ImplBlock {
  typeName: string;
  /** Set when the block is `impl <Trait> for <Type>`. */
  traitPath?: string;
  line: number;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * `#[contractimpl] impl Payroll { … }` and
 * `#[contractimpl] impl token::TokenInterface for MyToken { … }` are both
 * contract interfaces. The second form is how the most-copied contract in the
 * ecosystem — a token — is written, so filing the block under the trait instead
 * of the implementing type made an entire class of real contracts come back
 * with no functions at all.
 */
function collectContractImpls(src: string): ImplBlock[] {
  const out: ImplBlock[] = [];
  const re = new RegExp(
    String.raw`#\[${ATTR_PATH}contractimpl\]\s*(?:#\[[^\]]*\]\s*)*impl(?:\s*<[^>]*>)?\s+([\w:]+)(?:\s*<[^>]*>)?(?:\s+for\s+([\w:]+)(?:\s*<[^>]*>)?)?`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const brace = src.indexOf('{', m.index + m[0].length);
    if (brace === -1) continue;

    const first = m[1];
    const afterFor = m[2];
    if (!first) continue;

    // With `for`, the implementing type is the second path and the first is the
    // trait. Without it, the first path is the type itself.
    const typePath = afterFor ?? first;
    const parts = typePath.split('::');

    out.push({
      typeName: parts[parts.length - 1] ?? typePath,
      traitPath: afterFor ? first : undefined,
      line: lineAt(src, m.index),
      bodyStart: brace,
      bodyEnd: matchBrace(src, brace),
    });
  }
  return out;
}

function collectImports(src: string): ImportDecl[] {
  const out: ImportDecl[] = [];
  const re = /contractimport!\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const args = m[1] ?? '';
    const fileMatch = /file\s*=\s*"([^"]+)"/.exec(args);
    out.push({
      module: enclosingModule(src, m.index),
      wasmFile: fileMatch?.[1],
      line: lineAt(src, m.index),
    });
  }
  return out;
}

/** Find the nearest `mod X {` that encloses `index`. */
function enclosingModule(src: string, index: number): string | undefined {
  const re = /\bmod\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  let best: string | undefined;
  while ((m = re.exec(src)) !== null) {
    if (m.index > index) break;
    const open = src.indexOf('{', m.index);
    if (open === -1) continue;
    if (matchBrace(src, open) > index) best = m[1];
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Function parsing
 * ------------------------------------------------------------------ */

/**
 * Free functions in this file, indexed by name, with the storage they touch.
 * Skipped: anything inside a `#[contractimpl]` block (already parsed as an
 * entry point) and declarations with no body.
 */
function collectFreeFunctions(
  src: string,
  implRanges: [number, number][],
  file?: string,
): Map<string, HelperFn> {
  const out = new Map<string, HelperFn>();
  const re = /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (!name) continue;
    if (implRanges.some(([start, end]) => m!.index >= start && m!.index < end)) continue;

    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchParen(src, parenOpen);
    const braceOpen = src.indexOf('{', parenClose);
    if (braceOpen === -1) continue;
    // `fn foo();` in a trait declaration has no body to read.
    if (src.slice(parenClose, braceOpen).includes(';')) continue;

    const body = src.slice(braceOpen, matchBrace(src, braceOpen));
    // The line numbers below are counted in *this* file, which is not
    // necessarily the file whose entry points end up folding the helper in.
    const storage = parseStorage(body, lineAt(src, braceOpen), file);

    out.set(name, {
      storage,
      events: parseEvents(body),
      clientCalls: parseClientCalls(body),
      returnsStorageKey: soleStorageRead(storage),
      file,
    });
  }
  return out;
}

/**
 * When a helper does exactly one storage read and no writes, its return value is
 * that stored value — which is how `read_admin(&env)` yields the admin address.
 */
function soleStorageRead(storage: StorageAccess[]): string | undefined {
  const reads = storage.filter((s) => s.op === 'get' || s.op === 'try_get');
  const writes = storage.filter((s) => s.op === 'set' || s.op === 'update' || s.op === 'remove');
  if (reads.length !== 1 || writes.length > 0) return undefined;
  return reads[0]?.key;
}

function parseImplFunctions(
  src: string,
  from: number,
  to: number,
  isTraitImpl = false,
  helpers: Map<string, HelperFn> = new Map(),
  file?: string,
): FunctionDecl[] {
  const body = src.slice(from, to);
  const out: FunctionDecl[] = [];
  // Rust forbids `pub` on trait-impl methods — they are public by definition —
  // so requiring it there hid every function of a trait-based contract. In an
  // inherent impl `pub` still matters, and keeps private helpers out.
  const re = isTraitImpl
    ? /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g
    : /\bpub\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (!name) continue;
    const guards = guardAttributesBefore(body, m.index);
    const parenOpen = from + m.index + m[0].length - 1;
    const parenClose = matchParen(src, parenOpen);
    const paramText = src.slice(parenOpen + 1, parenClose - 1);

    // Return type sits between `)` and the body's `{`.
    const braceOpen = src.indexOf('{', parenClose);
    if (braceOpen === -1 || braceOpen >= to) continue;
    const between = src.slice(parenClose, braceOpen);
    const arrow = between.indexOf('->');
    const returns = arrow === -1 ? undefined : between.slice(arrow + 2).replace(/\bwhere\b[\s\S]*$/, '').trim();

    const bodyEnd = matchBrace(src, braceOpen);
    const fnBody = src.slice(braceOpen, bodyEnd);

    const params = parseParams(paramText);

    // Fold in whatever the helpers this body calls do. Without this, a contract
    // that keeps its storage access in `balance.rs` — the canonical layout —
    // appears to touch no storage at all.
    const called = [...helpers.entries()].filter(([helperName]) =>
      callsFreeFunction(fnBody, helperName),
    );

    out.push({
      name,
      line: lineAt(src, from + m.index),
      params,
      returns: returns || undefined,
      requiresAuth: /\brequire_auth(_for_args)?\s*\(/.test(fnBody) || guards.length > 0,
      authSubjects: [
        ...guards.map((guard) => ({
          expr: `#[${guard}]`,
          origin: 'guard-macro' as const,
          forArgs: false,
        })),
        ...parseAuthSubjects(fnBody, params, helpers),
      ],
      guards,
      // A folded-in access keeps the file and line it was written at. Those two
      // travel together: reporting a helper's line against the caller's file
      // points a reader at code that is not there.
      storage: [
        ...parseStorage(fnBody, lineAt(src, braceOpen), file),
        ...called.flatMap(([, helper]) => helper.storage),
      ],
      events: [...parseEvents(fnBody), ...called.flatMap(([, helper]) => helper.events)],
      clientCalls: [
        ...new Set([
          ...parseContractCalls(fnBody, params, helpers).map((c) => c.client),
          ...called.flatMap(([, helper]) => helper.clientCalls),
        ]),
      ],
      contractCalls: parseContractCalls(fnBody, params, helpers),
      upgradesContract: /\bupdate_current_contract_wasm\s*\(/.test(fnBody),
    });
  }

  return out;
}

/**
 * Does this body call `name` as a free function?
 *
 * `\b` matches after a dot, so `token::Client::new(&e, &t).transfer(&from, …)`
 * read as a call to the free `transfer` helper of a `balance.rs`, and that
 * helper's storage, events and client calls were folded into a function that
 * touches none of them. With helpers named `balance`, `mint`, `get`, `set` and
 * `transfer` — the whole vocabulary of a token — that fabricates most of a
 * contract's storage edges, each one an assertion the tool cannot evidence.
 *
 * A path-qualified call is deliberately not counted either. `balance::transfer(…)`
 * really is the helper, but `Vec::new(&env)` is indistinguishable from a call to
 * a helper named `new`, and inventing storage access for a constructor is worse
 * than missing a qualified call — the unqualified `use`d form is what the
 * official examples are written in.
 */
function callsFreeFunction(fnBody: string, name: string): boolean {
  // Helper names come from `(\w+)`, so there is nothing here to escape.
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(fnBody[i] ?? '')) i--;
    if (fnBody[i] === '.') continue; // a method on some receiver
    // `::` only. A single colon is a struct-literal field — `State { admin:
    // read_admin(&e) }` really does call the helper.
    if (fnBody[i] === ':' && fnBody[i - 1] === ':') continue;
    return true;
  }
  return false;
}

function matchParen(src: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

function parseParams(text: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  for (const part of splitTopLevel(text, ',')) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('&self') || trimmed === 'self') continue;
    const colon = indexOfTopLevelColon(trimmed);
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const type = trimmed.slice(colon + 1).trim();
    if (name && type) out.push({ name, type });
  }
  return out;
}

/** Split on a delimiter that is not nested inside <>, (), [] or {}. */
function splitTopLevel(text: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    else if (c === delim && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The `:` separating a parameter name from its type, ignoring `::` paths. */
function indexOfTopLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth--;
    else if (c === ':' && depth === 0) {
      if (text[i + 1] === ':') { i++; continue; }
      return i;
    }
  }
  return -1;
}

function parseStorage(fnBody: string, baseLine: number, file?: string): StorageAccess[] {
  const out: StorageAccess[] = [];
  const bindings = collectLetBindings(fnBody);
  const re =
    /storage\s*\(\s*\)\s*\.\s*(instance|persistent|temporary)\s*\(\s*\)\s*\.\s*(\w+)\s*(?:::\s*<[^>]*>\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    const durability = m[1] as StorageDurability;
    const method = m[2] ?? '';
    const op = STORAGE_OPS[method];
    // An unrecognised method is not evidence of anything; say nothing about it
    // rather than guessing what it did.
    if (!op) continue;

    const argsOpen = m.index + m[0].length - 1;
    const argsClose = matchParen(fnBody, argsOpen);
    const args = fnBody.slice(argsOpen + 1, argsClose - 1);

    // Instance storage is a single entry, so extending its TTL names no key —
    // the arguments are ledger thresholds.
    const keyless = op === 'extend_ttl' && durability === 'instance';
    const firstArg = keyless ? undefined : splitTopLevel(args, ',')[0]?.trim().replace(/^&/, '');

    out.push({
      durability,
      op,
      key: firstArg ? canonicaliseKey(firstArg, bindings) : undefined,
      line: baseLine + countNewlines(fnBody.slice(0, m.index)),
      file,
    });
  }
  return out;
}

/**
 * `let key = DataKey::Balance(token.clone());` followed by
 * `storage().persistent().set(&key, …)` is the idiomatic way to write Soroban
 * storage access, and treating `key` as a distinct key from `DataKey::Balance`
 * would report a missing TTL extension on code that does extend it. Resolving
 * these bindings is what keeps the TTL warning trustworthy.
 */
function collectLetBindings(fnBody: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\blet\s+(?:mut\s+)?(\w+)\s*(?::\s*[^=;]+)?=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    const name = m[1];
    const value = m[2];
    // Only the first binding matters; shadowing is rare in contract bodies and
    // guessing wrong is worse than not resolving at all.
    if (name && value && !out.has(name)) out.set(name, value.trim());
  }
  return out;
}

/**
 * Normalise a key expression so the same logical key written two ways —
 * `DataKey::LastPaid(employee)` and `DataKey::LastPaid(employee.clone())` —
 * collapses to one storage node.
 */
function canonicaliseKey(expr: string, bindings: Map<string, string>): string {
  let key = expr.trim();

  // A bare identifier is almost always a local binding of the real key.
  if (/^\w+$/.test(key)) {
    const bound = bindings.get(key);
    if (bound) key = bound.replace(/^&/, '').trim();
  }

  return key
    .replace(/\.clone\s*\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Capture whose authority each `require_auth` demands.
 *
 * `admin.require_auth()` where `admin` was loaded from `DataKey::Admin` is a
 * real access-control gate. `admin.require_auth()` where `admin` is a parameter
 * the caller supplied proves only that the caller controls an address they
 * chose — it restricts nobody. The two are indistinguishable from a boolean,
 * which is why this exists.
 */
function parseAuthSubjects(
  fnBody: string,
  params: { name: string; type: string }[],
  helpers: Map<string, HelperFn> = new Map(),
): AuthSubject[] {
  const bindings = collectLetBindings(fnBody);
  const paramNames = new Set(params.map((p) => p.name));
  const out: AuthSubject[] = [];

  const re = /\.\s*require_auth(_for_args)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    const expr = receiverBefore(fnBody, m.index);
    if (!expr) continue;

    const root = expr.split(/[.:]/)[0]?.trim() ?? expr;
    let origin: AuthOrigin = 'unknown';
    let key: string | undefined;

    if (/current_contract_address/.test(expr)) {
      origin = 'current_contract';
    } else if (paramNames.has(root)) {
      origin = 'param';
    } else {
      const bound = bindings.get(root);
      const loaded = bound
        ? /storage\s*\(\s*\)\s*\.\s*\w+\s*\(\s*\)\s*\.\s*(?:get|try_get)\s*(?:::\s*<[^>]*>\s*)?\(\s*&?\s*([^,)]+)/.exec(
            bound,
          )
        : null;

      if (loaded?.[1]) {
        origin = 'storage';
        key = loaded[1].replace(/\.clone\s*\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
      } else if (bound) {
        // `let admin = read_admin(&env);` — follow the helper to the key it reads.
        const call = /^\s*(\w+)\s*\(/.exec(bound);
        const helper = call?.[1] ? helpers.get(call[1]) : undefined;
        if (helper?.returnsStorageKey) {
          origin = 'storage';
          key = helper.returnsStorageKey;
        }
      }
    }

    out.push({ expr, origin, key, forArgs: m[1] !== undefined });
  }

  return out;
}

/**
 * Walk backwards from a `.method(` call to recover the receiver expression,
 * following identifiers, paths and balanced call parentheses.
 */
function receiverBefore(text: string, dotIndex: number): string | undefined {
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(text[i] ?? '')) i--;

  const end = i + 1;
  while (i >= 0) {
    const c = text[i] ?? '';
    if (c === ')') {
      // Skip a balanced call such as `current_contract_address()`.
      let depth = 0;
      while (i >= 0) {
        const d = text[i] ?? '';
        if (d === ')') depth++;
        else if (d === '(') {
          depth--;
          if (depth === 0) { i--; break; }
        }
        i--;
      }
      continue;
    }
    if (/[\w:.&]/.test(c)) { i--; continue; }
    break;
  }

  const expr = text.slice(i + 1, end).replace(/^&+/, '').trim();
  return expr || undefined;
}

function parseEvents(fnBody: string): string[] {
  const out: string[] = [];
  const re = /events\s*\(\s*\)\s*\.\s*publish\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(fnBody, open);
    const args = fnBody.slice(open + 1, close - 1);
    const topics = splitTopLevel(args, ',')[0]?.trim();
    if (topics) out.push(eventName(topics));
  }
  return out;
}

/**
 * The first topic of a published event is conventionally a symbol naming it —
 * `(Symbol::new(&env, "paid"), employee)` or `(symbol_short!("paid"), …)`.
 * Pulling that literal out gives `paid` instead of the whole tuple expression,
 * which is what a developer actually calls the event.
 */
function eventName(topicExpression: string): string {
  const literal =
    /Symbol::new\s*\(\s*&?\s*\w+\s*,\s*"([^"]+)"\s*\)/.exec(topicExpression) ??
    /symbol_short!\s*\(\s*"([^"]+)"\s*\)/.exec(topicExpression);
  if (literal?.[1]) return literal[1];
  return normaliseWhitespace(topicExpression.replace(/^\(|\)$/g, ''));
}

function parseClientCalls(fnBody: string): string[] {
  return [...new Set(parseContractCalls(fnBody, [], new Map()).map((c) => c.client))];
}

/**
 * Every contract client constructed in this body, with the address it targets
 * and the methods called on it.
 *
 * The address matters as much as the callee: a token address read from storage
 * is configuration, while one taken as a parameter is chosen by the caller —
 * the same distinction that makes `require_auth` meaningful or meaningless.
 */
function parseContractCalls(
  fnBody: string,
  params: { name: string; type: string }[],
  helpers: Map<string, HelperFn>,
): ContractCall[] {
  const out: ContractCall[] = [];
  const bindings = collectLetBindings(fnBody);
  const paramNames = new Set(params.map((p) => p.name));

  // `foo::Client::new(`, `FooClient::new(`, `token::TokenClient::new(`
  const re = /\b(?:(\w+)\s*::\s*)?(\w*Client)\s*::\s*new\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(fnBody)) !== null) {
    const modulePath = m[1];
    const clientType = m[2] ?? 'Client';

    // Which contract is this? The type's own prefix is the most specific name —
    // `token::StellarAssetClient` is a SAC client, not "the token module". A
    // bare `Client` carries no prefix, so there the module path is the name.
    const bare = clientType.replace(/Client$/, '');
    const client = bare || modulePath || clientType;

    let kind: ClientKind = 'generated';
    if (/^StellarAsset$/i.test(bare) || /^stellar_?asset$/i.test(client)) kind = 'stellar-asset';
    else if (/^Token$/i.test(bare) || /^token$/i.test(client)) kind = 'token';

    const open = m.index + m[0].length - 1;
    const close = matchParen(fnBody, open);
    const args = splitTopLevel(fnBody.slice(open + 1, close - 1), ',');
    // `::new(&env, &address)` — the address is the second argument.
    const address = args[1]?.trim().replace(/^&/, '').replace(/\.clone\s*\(\s*\)/g, '').trim();

    let addressOrigin: AuthOrigin = 'unknown';
    let addressKey: string | undefined;
    if (address) {
      const root = address.split(/[.:]/)[0]?.trim() ?? address;
      if (paramNames.has(root)) {
        addressOrigin = 'param';
      } else {
        const resolved = resolveStorageBinding(root, bindings, helpers);
        if (resolved) {
          addressOrigin = 'storage';
          addressKey = resolved;
        }
      }
    }

    // A client is either bound to a name and used, or constructed and called on
    // the spot. Reading only the first shape left the most-copied form in the
    // official examples with no methods at all: the edge existed but said
    // nothing, so a call that moves funds looked exactly like a query.
    const binding = bindingNameAt(fnBody, m.index);
    const methods = binding
      ? methodsCalledOn(fnBody, binding)
      : chainedMethodAfter(fnBody, close);

    out.push({
      client,
      kind,
      address: address || undefined,
      addressOrigin,
      addressKey,
      methods,
      line: countNewlines(fnBody.slice(0, m.index)),
    });
  }

  return out;
}

/**
 * Access-control attributes attached to the function starting at `index`.
 *
 * Walks backwards over the contiguous run of `#[...]` attributes immediately
 * preceding it, so `#[only_owner]` two attributes above the `pub fn` still
 * counts, while an attribute on an unrelated earlier item does not.
 */
function guardAttributesBefore(body: string, index: number): string[] {
  const found: string[] = [];
  let cursor = index;

  for (;;) {
    // Skip whitespace back to the previous non-space character.
    let i = cursor - 1;
    while (i >= 0 && /\s/.test(body[i] ?? '')) i--;
    if (i < 0 || body[i] !== ']') break;

    // Walk back to the matching `#[`.
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      const c = body[j];
      if (c === ']') depth++;
      else if (c === '[') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j <= 0 || body[j - 1] !== '#') break;

    const inner = body.slice(j + 1, i).trim();
    if (ACCESS_GUARD_ATTRS.test(inner)) {
      const name = /^(\w+)/.exec(inner)?.[1];
      if (name && !found.includes(name)) found.unshift(name);
    }
    cursor = j - 1;
  }

  return found;
}

/** `let client = X::new(…)` — the name the constructed client was bound to. */
function bindingNameAt(fnBody: string, callIndex: number): string | undefined {
  const before = fnBody.slice(Math.max(0, callIndex - 200), callIndex);
  const m = /\blet\s+(?:mut\s+)?(\w+)\s*(?::\s*[^=;]+)?=\s*$/.exec(before);
  return m?.[1];
}

/**
 * The method invoked directly on a freshly constructed client:
 * `token::Client::new(&e, &t).transfer(&from, &to, &amount)`.
 *
 * Exactly one link of the chain is read. Anything past it is called on the
 * *result* of that method, not on the client — reporting `unwrap` from
 * `…try_balance(&who).unwrap()` as a contract method would be an invented fact
 * about the callee's interface.
 */
function chainedMethodAfter(fnBody: string, afterCall: number): string[] {
  let i = afterCall;
  while (i < fnBody.length && /\s/.test(fnBody[i] ?? '')) i++;
  if (fnBody[i] !== '.') return [];
  i++;
  while (i < fnBody.length && /\s/.test(fnBody[i] ?? '')) i++;
  const method = /^(\w+)\s*\(/.exec(fnBody.slice(i, i + 120))?.[1];
  return method ? [method] : [];
}

/** Methods invoked on a bound client, e.g. `client.withdraw(...)`. */
function methodsCalledOn(fnBody: string, binding: string | undefined): string[] {
  if (!binding) return [];
  const out = new Set<string>();
  const re = new RegExp(`\\b${binding}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/** Resolve a local binding to the storage key it was loaded from, if any. */
function resolveStorageBinding(
  root: string,
  bindings: Map<string, string>,
  helpers: Map<string, HelperFn>,
): string | undefined {
  const bound = bindings.get(root);
  if (!bound) return undefined;

  const direct =
    /storage\s*\(\s*\)\s*\.\s*\w+\s*\(\s*\)\s*\.\s*(?:get|try_get)\s*(?:::\s*<[^>]*>\s*)?\(\s*&?\s*([^,)]+)/.exec(
      bound,
    );
  if (direct?.[1]) {
    return direct[1].replace(/\.clone\s*\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  const call = /^\s*(\w+)\s*\(/.exec(bound);
  return call?.[1] ? helpers.get(call[1])?.returnsStorageKey : undefined;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++;
  return count;
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
