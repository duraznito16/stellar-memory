/**
 * A note is one Markdown file in the vault: YAML frontmatter, a machine-owned
 * block, and everything else.
 *
 * The contract with the user is simple and worth stating plainly, because it is
 * what makes this a memory rather than a report: text inside the auto markers is
 * rewritten on every scan; text outside them is never touched. A developer can
 * annotate any note with the reasoning behind a decision and keep it forever,
 * while the structural facts underneath stay current.
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

export function parseNote(raw: string): ParsedNote {
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

  const open = body.indexOf(AUTO_OPEN);
  const close = body.indexOf(AUTO_CLOSE);

  if (open === -1 || close === -1 || close < open) {
    // No auto block yet: the whole body belongs to the human.
    return { frontmatter, auto: '', human: body.trim() };
  }

  const auto = body.slice(open + AUTO_OPEN.length, close).trim();
  const before = body.slice(0, open).trim();
  const after = body.slice(close + AUTO_CLOSE.length).trim();
  const human = [before, after].filter(Boolean).join('\n\n');

  return { frontmatter, auto, human };
}

export function serialiseNote(note: ParsedNote): string {
  const parts: string[] = [];

  if (Object.keys(note.frontmatter).length > 0) {
    const yaml = stringifyYaml(note.frontmatter, { lineWidth: 0 }).trimEnd();
    parts.push(`---\n${yaml}\n---`);
  }

  parts.push(`${AUTO_OPEN}\n${note.auto.trim()}\n${AUTO_CLOSE}`);

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
 * Merge a freshly generated body into an existing note on disk, keeping the
 * developer's prose intact.
 */
export function mergeNote(
  existingRaw: string | null,
  frontmatter: Record<string, unknown>,
  auto: string,
): string {
  const existing = existingRaw ? parseNote(existingRaw) : { ...EMPTY };
  return serialiseNote({ frontmatter, auto, human: existing.human });
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
