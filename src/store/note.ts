/**
 * A note is one Markdown file in the vault: YAML frontmatter, a machine-owned
 * block, and everything else.
 *
 * The contract with the user is simple and worth stating plainly, because it is
 * what makes this a memory rather than a report: text inside the auto markers is
 * rewritten on every scan; text outside them is never touched. A developer can
 * annotate any note with the reasoning behind a decision and keep it forever,
 * while the structural facts underneath stay current.
 *
 * The header is a third region and the same rule holds there: the keys listed in
 * `MACHINE_KEYS` are this tool's to rewrite, and every other key belongs to
 * whoever typed it — Obsidian's readers keep real configuration up there.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const AUTO_OPEN = '<!-- stellar-memory:auto -->';
const AUTO_CLOSE = '<!-- /stellar-memory:auto -->';

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  /** Machine-generated body, between the auto markers. */
  auto: string;
  /** Everything after the auto block: the developer's own words. */
  human: string;
}

const EMPTY: ParsedNote = { frontmatter: {}, auto: '', human: '' };

/**
 * Where a marker is used as a marker: alone on its line, which is the only way
 * this file ever writes one. Someone quoting `<!-- stellar-memory:auto -->` in a
 * sentence about how the format works is describing the block, not opening one.
 */
function markerPositions(body: string, marker: string): number[] {
  const out: number[] = [];
  for (let at = body.indexOf(marker); at !== -1; at = body.indexOf(marker, at + marker.length)) {
    const startsLine = at === 0 || body[at - 1] === '\n';
    const rest = body.slice(at + marker.length);
    if (startsLine && (rest === '' || rest.startsWith('\n') || rest.startsWith('\r\n'))) {
      out.push(at);
    }
  }
  return out;
}

export function parseNote(source: string): ParsedNote {
  // Notepad and PowerShell 5.1 redirection both leave a BOM behind. Without this
  // the frontmatter below is not recognised, the note reads as having no `id`,
  // and the vault can no longer tell its own notes from a developer's.
  const raw = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (!raw.trim()) return { ...EMPTY };

  let body = raw;
  let frontmatter: Record<string, unknown> = {};

  // Frontmatter must open on the very first line to count.
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const yamlText = raw.slice(3, end);
      const afterFence = raw.indexOf('\n', end + 1);
      body = afterFence === -1 ? '' : raw.slice(afterFence + 1);
      try {
        const parsed = parseYaml(yamlText);
        if (parsed && typeof parsed === 'object') {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed frontmatter is the developer's file, not ours to discard.
        // Treat it as absent and preserve the raw text as human content.
        body = raw;
      }
    }
  }

  const opens = markerPositions(body, AUTO_OPEN);
  const closes = markerPositions(body, AUTO_CLOSE);
  // The block has to close after it opens. A developer writing about this format
  // in their own notes leaves markers in any order.
  const close = opens.length === 0 ? undefined : closes.find((at) => at > opens[0]!);

  if (close === undefined) {
    // No auto block yet: the whole body belongs to the human.
    return { frontmatter, auto: '', human: body.trim() };
  }

  // More than one opening marker before the close means one of them is the
  // developer's. Pair the innermost, so ambiguous text is read as prose: taking
  // generated text for prose costs a scan, taking prose for generated text costs
  // the prose.
  const open = opens.filter((at) => at < close).at(-1)!;

  const auto = body.slice(open + AUTO_OPEN.length, close).trim();
  const before = body.slice(0, open).trim();
  const after = body.slice(close + AUTO_CLOSE.length).trim();
  const human = [before, after].filter(Boolean).join('\n\n');

  return { frontmatter, auto, human };
}

/**
 * The generated block quotes doc comments, summaries and config values verbatim,
 * so a project that documents this very format writes the closing marker into
 * its own README. Emitted as-is it would end the block early, everything after
 * it would come back as the developer's own text on the next scan, and the note
 * would grow a copy of itself every time. The escaped form still reads as the
 * marker once rendered.
 */
function neutraliseMarkers(text: string): string {
  return text
    .replaceAll(AUTO_OPEN, `&lt;${AUTO_OPEN.slice(1)}`)
    .replaceAll(AUTO_CLOSE, `&lt;${AUTO_CLOSE.slice(1)}`);
}

export function serialiseNote(note: ParsedNote): string {
  const parts: string[] = [];

  if (Object.keys(note.frontmatter).length > 0) {
    const yaml = stringifyYaml(note.frontmatter, { lineWidth: 0 }).trimEnd();
    parts.push(`---\n${yaml}\n---`);
  }

  parts.push(`${AUTO_OPEN}\n${neutraliseMarkers(note.auto.trim())}\n${AUTO_CLOSE}`);

  const human = note.human.trim();
  parts.push(human ? human : HUMAN_PLACEHOLDER);

  return parts.join('\n\n') + '\n';
}

const HUMAN_PLACEHOLDER = [
  '## Notes',
  '',
  '<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->',
].join('\n');

/**
 * Frontmatter keys this tool writes. Everything else in a header was put there
 * by hand — Obsidian's `aliases` and `cssclasses`, a reader's own fields — and
 * is carried across scans like the prose is.
 *
 * A key we stop emitting has to stay on this list: it is what tells a value we
 * wrote last month from one a developer typed, and the leftover would otherwise
 * sit in the file forever looking current.
 */
const MACHINE_KEYS = new Set([
  'id',
  'kind',
  'title',
  'path',
  'summary',
  'first_seen',
  'last_changed',
  'tags',
  'stale',
  'stale_since',
]);

function asTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
  return typeof value === 'string' ? [value] : [];
}

function mergeFrontmatter(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!MACHINE_KEYS.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(generated)) merged[key] = value;

  // Tags are the one field both sides write. Ours have to be there for the
  // graph view to filter on `kind/`, but a tag someone added by hand is theirs.
  const kept = asTags(existing.tags).filter((tag) => !asTags(generated.tags).includes(tag));
  if (kept.length > 0 && generated.tags !== undefined) {
    merged.tags = [...asTags(generated.tags), ...kept];
  }

  return merged;
}

/**
 * Merge a freshly generated body into an existing note on disk, keeping the
 * developer's prose — and their own frontmatter — intact.
 */
export function mergeNote(
  existingRaw: string | null,
  frontmatter: Record<string, unknown>,
  auto: string,
): string {
  const existing = existingRaw ? parseNote(existingRaw) : { ...EMPTY };
  return serialiseNote({
    frontmatter: mergeFrontmatter(existing.frontmatter, frontmatter),
    auto,
    human: existing.human,
  });
}

/** Extract `[[wikilink]]` targets from a note body. */
export function extractWikilinks(text: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1]?.trim();
    if (target) out.add(target);
  }
  return [...out];
}
