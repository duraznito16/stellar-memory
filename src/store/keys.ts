/**
 * Note identity: how a node id becomes a file path and a wikilink.
 *
 * Kept separate from both vault I/O and rendering so the two can depend on it
 * without depending on each other.
 */

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

export function slugify(value: string): string {
  const slug = value
    .replace(/[^\w.\-/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return slug || 'unnamed';
}

/** `contract:payroll` -> `contracts/payroll` (vault-relative, no extension). */
export function noteKey(node: Pick<MemoryNode, 'id' | 'kind'>): string {
  const local = node.id.includes(':') ? node.id.slice(node.id.indexOf(':') + 1) : node.id;
  const folder = KIND_FOLDER[node.kind];
  // Notes are already Markdown; a doc node for README.md must not become
  // `readme.md.md`.
  const slug = slugify(local).replace(/\.md$/, '');
  return folder === '.' ? slug : `${folder}/${slug}`;
}

/**
 * The Obsidian-resolvable link for a node. Folder-qualified because a `type` and
 * a `contract` may legitimately share a name.
 */
export function wikilink(node: Pick<MemoryNode, 'id' | 'kind' | 'title'>): string {
  return `[[${noteKey(node)}|${node.title}]]`;
}
