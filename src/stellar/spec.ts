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

export function parseSpec(entries: unknown): ParsedSpec {
  const out: ParsedSpec = {
    functions: [], events: [], structs: [], enums: [], unions: [], errors: [],
  };
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.function_v0) out.functions.push(e.function_v0 as SpecFunction);
    else if (e.event_v0) out.events.push(e.event_v0 as SpecEvent);
    else if (e.udt_struct_v0) out.structs.push(e.udt_struct_v0 as SpecUdt);
    else if (e.udt_enum_v0) out.enums.push(e.udt_enum_v0 as SpecUdt);
    else if (e.udt_union_v0) out.unions.push(e.udt_union_v0 as SpecUdt);
    else if (e.udt_error_enum_v0) out.errors.push(e.udt_error_enum_v0 as SpecUdt);
  }
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
  const params = fn.inputs.map((i) => `${i.name}: ${formatSpecType(i.type_)}`).join(', ');
  const outputs = fn.outputs ?? [];
  const ret =
    outputs.length === 0
      ? ''
      : ` -> ${outputs.length === 1 ? formatSpecType(outputs[0]) : `(${outputs.map(formatSpecType).join(', ')})`}`;
  return `${fn.name}(${params})${ret}`;
}

/** First line of the doc comment, which is usually the useful summary. */
export function docSummary(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const first = doc.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
  return first || undefined;
}
