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
}

/** Where the address passed to `require_auth` came from. */
export type AuthOrigin = 'param' | 'storage' | 'current_contract' | 'unknown';

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
  /** True when this function calls `update_current_contract_wasm`. */
  upgradesContract: boolean;
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

export interface RustFileAnalysis {
  rel: string;
  contracts: ContractDecl[];
  /** `#[contracttype]` structs and enums. */
  types: NamedDecl[];
  /** `#[contracterror]` enums. */
  errors: NamedDecl[];
  /** `#[contractevent]` structs. */
  events: NamedDecl[];
  imports: ImportDecl[];
  isTest: boolean;
  usesSorobanSdk: boolean;
}

export function analyseRustFile(rel: string, source: string): RustFileAnalysis {
  const src = stripComments(source);

  const analysis: RustFileAnalysis = {
    rel,
    contracts: [],
    types: collectAttributed(src, 'contracttype'),
    errors: collectAttributed(src, 'contracterror'),
    events: collectAttributed(src, 'contractevent'),
    imports: collectImports(src),
    // `#![cfg(test)]` (inner) is as common as `#[cfg(test)]` (outer) at the top
    // of a test module, and `test.rs` / `tests.rs` are the conventional names.
    isTest:
      /#!?\[cfg\(test\)\]/.test(src) ||
      /(^|\/)tests?\//.test(rel) ||
      /(^|\/)_?tests?\.rs$/.test(rel),
    usesSorobanSdk: /\bsoroban_sdk\b/.test(src),
  };

  const contractNames = collectContractNames(src);
  const impls = collectContractImpls(src);

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
      ...parseImplFunctions(src, impl.bodyStart, impl.bodyEnd, impl.traitPath !== undefined),
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
 * Declaration collection
 * ------------------------------------------------------------------ */

function collectContractNames(src: string): NamedDecl[] {
  const out: NamedDecl[] = [];
  // `#[contract]` exactly — not `#[contracttype]`, `#[contractimpl]`, etc.
  const re = /#\[contract\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out.push({ name: m[1], line: lineAt(src, m.index) });
  }
  return out;
}

function collectAttributed(src: string, attr: string): NamedDecl[] {
  const out: NamedDecl[] = [];
  const re = new RegExp(
    `#\\[${attr}(?:\\([^)]*\\))?\\]\\s*(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\s*\\([^)]*\\))?\\s+)?(?:struct|enum)\\s+(\\w+)`,
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
  const re =
    /#\[contractimpl\]\s*(?:#\[[^\]]*\]\s*)*impl(?:\s*<[^>]*>)?\s+([\w:]+)(?:\s*<[^>]*>)?(?:\s+for\s+([\w:]+)(?:\s*<[^>]*>)?)?/g;
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

function parseImplFunctions(
  src: string,
  from: number,
  to: number,
  isTraitImpl = false,
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
    out.push({
      name,
      line: lineAt(src, from + m.index),
      params,
      returns: returns || undefined,
      requiresAuth: /\brequire_auth(_for_args)?\s*\(/.test(fnBody),
      authSubjects: parseAuthSubjects(fnBody, params),
      storage: parseStorage(fnBody, lineAt(src, braceOpen)),
      events: parseEvents(fnBody),
      clientCalls: parseClientCalls(fnBody),
      upgradesContract: /\bupdate_current_contract_wasm\s*\(/.test(fnBody),
    });
  }

  return out;
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

function parseStorage(fnBody: string, baseLine: number): StorageAccess[] {
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
  const out = new Set<string>();
  // `contractimport!` generates `Client`, conventionally used as `foo::Client::new(...)`
  // or via a re-export as `FooClient::new(...)`.
  const re = /\b(\w+)\s*::\s*Client\s*::\s*new\s*\(|\b(\w+)Client\s*::\s*new\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    const name = m[1] ?? m[2];
    if (name) out.add(name);
  }
  return [...out];
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++;
  return count;
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
