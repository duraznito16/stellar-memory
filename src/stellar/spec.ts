/**
 * The contract spec as the Stellar CLI reports it.
 *
 * Shapes here were read off real output from
 * `stellar contract info interface --output json`, not inferred: a JSON array of
 * SCSpecEntry objects, each tagged with exactly one of `function_v0`,
 * `event_v0`, `udt_struct_v0`, `udt_enum_v0`, `udt_union_v0`,
 * `udt_error_enum_v0`.
 *
 * This is ground truth in a way source parsing can never be: it describes the
 * contract that actually exists, compiled or deployed.
 */

export interface SpecParam {
  doc?: string;
  name: string;
  type_: SpecType;
  /** Events only: whether the param travels as a topic or in the data payload. */
  location?: 'topic_list' | 'data';
}

/** A primitive name like `address`, or a nested descriptor like `{ vec: {...} }`. */
export type SpecType = string | Record<string, unknown>;

export interface SpecFunction {
  doc?: string;
  name: string;
  inputs: SpecParam[];
  outputs: SpecType[];
}

export interface SpecEvent {
  doc?: string;
  lib?: string;
  name: string;
  prefix_topics: string[];
  params: SpecParam[];
  data_format?: string;
}

export interface SpecErrorCase {
  doc?: string;
  name: string;
  value: number;
}

export interface SpecUdt {
  doc?: string;
  lib?: string;
  name: string;
  /** For `udt_error_enum_v0`, the variants and their wire discriminants. */
  cases?: SpecErrorCase[];
  fields?: unknown[];
}

export type SpecEntry =
  | { function_v0: SpecFunction }
  | { event_v0: SpecEvent }
  | { udt_struct_v0: SpecUdt }
  | { udt_enum_v0: SpecUdt }
  | { udt_union_v0: SpecUdt }
  | { udt_error_enum_v0: SpecUdt };

export interface ParsedSpec {
  functions: SpecFunction[];
  events: SpecEvent[];
  structs: SpecUdt[];
  enums: SpecUdt[];
  unions: SpecUdt[];
  errors: SpecUdt[];
}

/**
 * Read a spec into the shape the rest of the tool relies on.
 *
 * The casts this replaced were promises, not checks. Real CLI output does carry
 * `"inputs": []` for a niladic function, but a spec that omits its empty arrays
 * — an older CLI, a hand-written fixture, a stored interface — made
 * `fn.inputs.map` throw a TypeError deep inside rendering, well outside the
 * `try` in `fetchInterface`, which took down the whole scan instead of
 * degrading to "no interface". Everything a consumer iterates is guaranteed to
 * be an array here.
 */
export function parseSpec(entries: unknown): ParsedSpec {
  const out: ParsedSpec = {
    functions: [], events: [], structs: [], enums: [], unions: [], errors: [],
  };
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.function_v0) push(out.functions, asFunction(e.function_v0));
    else if (e.event_v0) push(out.events, asEvent(e.event_v0));
    else if (e.udt_struct_v0) push(out.structs, asUdt(e.udt_struct_v0));
    else if (e.udt_enum_v0) push(out.enums, asUdt(e.udt_enum_v0));
    else if (e.udt_union_v0) push(out.unions, asUdt(e.udt_union_v0));
    else if (e.udt_error_enum_v0) push(out.errors, asUdt(e.udt_error_enum_v0));
  }
  return out;
}

function push<T>(into: T[], value: T | null): void {
  if (value) into.push(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Params keep their position: dropping an unnamed one would misstate the arity. */
function asParams(value: unknown): SpecParam[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, i) => {
    const p = asRecord(raw) ?? {};
    return {
      ...p,
      name: typeof p.name === 'string' ? p.name : `arg${i}`,
    } as SpecParam;
  });
}

function asFunction(value: unknown): SpecFunction | null {
  const fn = asRecord(value);
  if (!fn || typeof fn.name !== 'string') return null;
  return {
    ...fn,
    name: fn.name,
    inputs: asParams(fn.inputs),
    outputs: Array.isArray(fn.outputs) ? (fn.outputs as SpecType[]) : [],
  } as SpecFunction;
}

function asEvent(value: unknown): SpecEvent | null {
  const ev = asRecord(value);
  if (!ev || typeof ev.name !== 'string') return null;
  return {
    ...ev,
    name: ev.name,
    prefix_topics: Array.isArray(ev.prefix_topics)
      ? ev.prefix_topics.filter((t): t is string => typeof t === 'string')
      : [],
    params: asParams(ev.params),
  } as SpecEvent;
}

function asUdt(value: unknown): SpecUdt | null {
  const udt = asRecord(value);
  if (!udt || typeof udt.name !== 'string') return null;
  const out: SpecUdt = { ...udt, name: udt.name } as SpecUdt;
  // `cases` and `fields` are optional in the spec, so absent stays absent —
  // but present and not an array is corrupt, and reads as absent too.
  out.cases = Array.isArray(udt.cases)
    ? (udt.cases.filter((c) => !!asRecord(c)) as SpecErrorCase[])
    : undefined;
  out.fields = Array.isArray(udt.fields) ? udt.fields : undefined;
  return out;
}

/** Render a spec type as something a developer would recognise. */
export function formatSpecType(type: SpecType | undefined): string {
  if (type === undefined || type === null) return 'void';
  if (typeof type === 'string') return type;

  const [key, value] = Object.entries(type)[0] ?? [];
  if (!key) return 'unknown';
  const v = (value ?? {}) as Record<string, unknown>;

  switch (key) {
    case 'udt':
      return typeof v.name === 'string' ? v.name : 'udt';
    case 'option':
      return `Option<${formatSpecType(v.value_type as SpecType)}>`;
    case 'vec':
      return `Vec<${formatSpecType(v.element_type as SpecType)}>`;
    case 'map':
      return `Map<${formatSpecType(v.key_type as SpecType)}, ${formatSpecType(v.value_type as SpecType)}>`;
    case 'result':
      return `Result<${formatSpecType(v.ok_type as SpecType)}, ${formatSpecType(v.error_type as SpecType)}>`;
    case 'tuple': {
      const parts = Array.isArray(v.value_types)
        ? (v.value_types as SpecType[]).map(formatSpecType)
        : [];
      return `(${parts.join(', ')})`;
    }
    case 'bytes_n':
      return `BytesN<${String(v.n ?? '?')}>`;
    default:
      return key;
  }
}

export function formatSignature(fn: SpecFunction): string {
  // Exported, so it is also reached with specs that never passed through
  // parseSpec — a stored interface, a fixture. The `?? []` on outputs showed
  // the case had been thought about; inputs got the same guard the day one
  // arrived without them and the TypeError ended the scan.
  const inputs = Array.isArray(fn?.inputs) ? fn.inputs : [];
  const params = inputs.map((i) => `${i?.name ?? '_'}: ${formatSpecType(i?.type_)}`).join(', ');
  const outputs = Array.isArray(fn?.outputs) ? fn.outputs : [];
  const ret =
    outputs.length === 0
      ? ''
      : ` -> ${outputs.length === 1 ? formatSpecType(outputs[0]) : `(${outputs.map(formatSpecType).join(', ')})`}`;
  return `${fn?.name ?? 'unknown'}(${params})${ret}`;
}

/** First line of the doc comment, which is usually the useful summary. */
export function docSummary(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const first = doc.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
  return first || undefined;
}
