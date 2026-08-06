/**
 * Note identity: how a node id becomes a file path and a wikilink.
 *
 * Kept separate from both vault I/O and rendering so the two can depend on it
 * without depending on each other.
 *
 * A key is not a property of one node on its own: two ids can slug to the same
 * name, and only the whole set says which ones. Vault I/O calls
 * `registerNoteKeys` on every load and every save, before anything is named or
 * linked; `noteKey` answers from that table.
 */

import { createHash } from 'node:crypto';
import type { MemoryNode, NodeKind } from '../core/types.js';

/** Folder name used for each node kind, so a vault reads sensibly in a file tree. */
export const KIND_FOLDER: Record<NodeKind, string> = {
  project: '.',
  crate: 'crates',
  contract: 'contracts',
  function: 'functions',
  type: 'types',
  error: 'errors',
  event: 'events',
  storage: 'storage',
  module: 'modules',
  test: 'tests',
  deployment: 'deployments',
  script: 'scripts',
  doc: 'docs',
  decision: 'decisions',
  task: 'tasks',
  asset: 'assets',
};

const FALLBACK_SLUG = 'unnamed';

/** Device names on Windows. `con.md` cannot be created there at all. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * A slug becomes a path under `notes/`, so it has to be a name and not a route.
 *
 * Ids are built from text this tool did not write — a Cargo manifest's `name`,
 * a path out of the repo being scanned — and nothing has validated it, because
 * a scan never runs cargo. Dropping `.` and `..` segments is what stops a
 * manifest declaring `name = "../../elsewhere"` from writing outside the vault,
 * where `markStaleNotes` would never see the file again either.
 */
function safeSegments(slug: string): string {
  return slug
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => (RESERVED.test(part.split('.')[0] ?? '') ? `_${part}` : part))
    .join('/');
}

function rawSlug(value: string): string {
  return safeSegments(
    value
      .replace(/[^\w.\-/]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase(),
  );
}

export function slugify(value: string): string {
  return rawSlug(value) || FALLBACK_SLUG;
}

/**
 * Enough of a hash to separate two ids that slug alike, short enough to still
 * read as a file name. Taken from the full id, so it is the same on every
 * machine and on every scan — the vault is diffed in git.
 */
function idHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

/**
 * Note keys the current node set needs in order to stay one-file-per-node.
 *
 * Uniqueness is a property of the whole set, but callers ask about one node at a
 * time — the renderer writes a wikilink knowing only the node it points at — so
 * the table is computed once per load or save and read back through `noteKey`.
 */
let disambiguated = new Map<string, string>();

/** `contract:payroll` -> `contracts/payroll` (vault-relative, no extension). */
export function noteKey(node: Pick<MemoryNode, 'id' | 'kind'>): string {
  return disambiguated.get(node.id) ?? baseNoteKey(node);
}

function baseNoteKey(node: Pick<MemoryNode, 'id' | 'kind'>): string {
  const local = node.id.includes(':') ? node.id.slice(node.id.indexOf(':') + 1) : node.id;
  const folder = KIND_FOLDER[node.kind];
  // Notes are already Markdown; a doc node for README.md must not become
  // `readme.md.md`.
  const slug = rawSlug(local).replace(/\.md$/, '');
  // A name with nothing ASCII left in it slugs to nothing at all, so every one
  // of them would land on the same file. There the hash is not a tie-break, it
  // is the only part of the name that says which node this is.
  const name = slug || `${FALLBACK_SLUG}-${idHash(node.id)}`;
  return folder === '.' ? name : `${folder}/${name}`;
}

/**
 * Give every node a key no other node shares, and remember it for `noteKey`.
 *
 * Distinct ids can slug alike — `docs/Design.md` and `docs/design.md` differ
 * only in case, and case cannot survive a file name on Windows or macOS. Two
 * nodes on one path is not a cosmetic problem: the second node reads the first
 * one's file, inherits its prose as its own, and writes it back under the wrong
 * name, which is the one thing in the vault that cannot be recovered.
 */
export function registerNoteKeys(
  nodes: Iterable<Pick<MemoryNode, 'id' | 'kind'>>,
): Map<string, string> {
  const unique = new Map<string, Pick<MemoryNode, 'id' | 'kind'>>();
  for (const node of nodes) if (!unique.has(node.id)) unique.set(node.id, node);

  const byKey = new Map<string, string[]>();
  for (const [id, node] of unique) {
    const key = baseNoteKey(node);
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }

  const table = new Map<string, string>();
  for (const [key, ids] of byKey) {
    if (ids.length === 1) {
      table.set(ids[0]!, key);
      continue;
    }
    // Every member of a collision is suffixed, never only the later ones:
    // whichever node kept the plain name would inherit whatever its twin had
    // already written there, and which node that is would depend on scan order.
    for (const id of ids) table.set(id, `${key}-${idHash(id)}`);
  }

  disambiguated = table;
  return table;
}

/**
 * The Obsidian-resolvable link for a node. Folder-qualified because a `type` and
 * a `contract` may legitimately share a name.
 */
export function wikilink(node: Pick<MemoryNode, 'id' | 'kind' | 'title'>): string {
  return `[[${noteKey(node)}|${node.title}]]`;
}
