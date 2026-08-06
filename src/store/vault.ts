/**
 * Vault I/O.
 *
 * A vault is a plain directory of Markdown notes plus a derived index.json.
 * Nothing here is a database: the point is that the memory stays diffable in git
 * and openable in Obsidian, so a team can review how their own understanding of
 * a project changed alongside the code that changed it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryEdge, MemoryNode, ProjectMemory } from '../core/types.js';
import { mergeNote, parseNote, serialiseNote } from './note.js';
import { noteKey, registerNoteKeys } from './keys.js';
import { renderNoteBody, renderFrontmatter } from './render.js';

export const VAULT_DIR = '.stellar-memory';
const INDEX_FILE = 'index.json';
const NOTES_DIR = 'notes';

export { noteKey, registerNoteKeys, slugify, wikilink } from './keys.js';

export function vaultPath(root: string): string {
  return path.join(root, VAULT_DIR);
}

/** Walk up from `start` looking for an initialised vault. */
export async function findVaultRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      const st = await fs.stat(path.join(dir, VAULT_DIR));
      if (st.isDirectory()) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function notePath(root: string, node: Pick<MemoryNode, 'id' | 'kind'>): string {
  return path.join(vaultPath(root), NOTES_DIR, `${noteKey(node)}.md`);
}

export async function isInitialised(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(vaultPath(root), INDEX_FILE));
    return true;
  } catch {
    return false;
  }
}

export function emptyMemory(name: string, root: string): ProjectMemory {
  return {
    version: 1,
    project: { name, root, networks: [] },
    nodes: [],
    edges: [],
    scans: [],
  };
}

export async function loadMemory(root: string): Promise<ProjectMemory> {
  const file = path.join(vaultPath(root), INDEX_FILE);
  const raw = await fs.readFile(file, 'utf8');
  // A BOM is what an editor on Windows leaves behind after someone opens the
  // index to look at it; JSON.parse refuses it, and the vault would then read as
  // one that had never been scanned.
  const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as ProjectMemory;
  if (parsed.version !== 1) {
    throw new Error(
      `This vault was written by a different version of stellar-memory (schema v${parsed.version}). ` +
        `Re-run \`stellar-memory scan\` to rebuild it.`,
    );
  }
  // The vault may have moved (cloned elsewhere); trust the caller's root.
  parsed.project.root = root;
  // Which file a node's note lives in depends on the rest of the set, so anyone
  // holding a memory — the MCP server, the graph, `explain` — needs the table
  // before it can name a note or link to one.
  registerNoteKeys(parsed.nodes);
  return parsed;
}

/** Load the memory, or return null when the project has no vault yet. */
export async function tryLoadMemory(root: string): Promise<ProjectMemory | null> {
  try {
    return await loadMemory(root);
  } catch {
    return null;
  }
}

let tempCounter = 0;

/**
 * Write by rename, so a destination only ever holds one whole file.
 *
 * A scan is interrupted by a Ctrl+C more often than by anything else, and the
 * file it was halfway through is either a note — which carries the developer's
 * own prose, the one thing here no rescan can reconstruct — or the index, which
 * stops the vault from loading at all if it ends mid-object.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  // The temporary file shares a directory with its destination: rename is only
  // atomic within one filesystem, and a vault can sit on a mount of its own.
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${tempCounter++}.tmp`,
  );
  await fs.writeFile(temp, data, 'utf8');
  try {
    await renameOver(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * On Windows the rename fails outright while anything else holds the destination
 * open — a search indexer, a virus scanner, Obsidian redrawing the note that
 * just changed. All of them let go within milliseconds.
 */
async function renameOver(temp: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function saveIndex(memory: ProjectMemory): Promise<void> {
  const dir = vaultPath(memory.project.root);
  await fs.mkdir(dir, { recursive: true });
  // `root` is machine-specific; keep it out of the committed file.
  const { root: _omit, ...project } = memory.project;
  const serialisable = { ...memory, project };
  await writeFileAtomic(path.join(dir, INDEX_FILE), JSON.stringify(serialisable, null, 2) + '\n');
}

/**
 * Write one Markdown note per node, preserving any prose the developer added.
 * Notes for nodes that no longer exist are left in place rather than deleted —
 * a vanished contract is exactly the kind of thing someone may have written
 * notes about, and silently deleting their writing would be unforgivable.
 */
export async function saveNotes(
  memory: ProjectMemory,
): Promise<{ written: number; stale: number }> {
  // Before anything is rendered: the links in a note are written from this
  // table, so it has to be the same one the files are named from.
  registerNoteKeys(memory.nodes);

  const byId = new Map(memory.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, MemoryEdge[]>();
  const incoming = new Map<string, MemoryEdge[]>();
  for (const edge of memory.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge);
  }

  let written = 0;
  const current = new Set<string>();

  for (const node of memory.nodes) {
    const file = notePath(memory.project.root, node);
    current.add(path.resolve(file));
    await fs.mkdir(path.dirname(file), { recursive: true });

    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      existing = null;
    }

    const body = renderNoteBody(node, {
      byId,
      outgoing: outgoing.get(node.id) ?? [],
      incoming: incoming.get(node.id) ?? [],
      memory,
    });
    await writeFileAtomic(file, mergeNote(existing, renderFrontmatter(node), body));
    written++;
  }

  const stale = await markStaleNotes(memory.project.root, current);
  return { written, stale };
}

/**
 * A note whose node no longer exists is not deleted — someone may have written
 * irreplaceable reasoning in it. But it must stop *looking* current, or the
 * vault will confidently describe a contract that was removed three months ago.
 * So the generated half is replaced with a notice and the human half is kept.
 */
async function markStaleNotes(root: string, current: Set<string>): Promise<number> {
  const notesDir = path.join(vaultPath(root), NOTES_DIR);
  const files = await listMarkdown(notesDir);
  const now = new Date().toISOString().slice(0, 10);
  let marked = 0;

  for (const file of files) {
    if (current.has(path.resolve(file))) continue;

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseNote(raw);
    // Only touch notes this tool generated, and only once.
    if (!parsed.frontmatter.id || parsed.frontmatter.stale === true) continue;

    const frontmatter = { ...parsed.frontmatter, stale: true, stale_since: now };
    const notice = [
      `> [!warning] No longer present`,
      `> This was last seen in the project on ${parsed.frontmatter.last_changed ?? 'an earlier scan'}.`,
      `> The scan on ${now} did not find it. Your own notes below are preserved.`,
    ].join('\n');

    await writeFileAtomic(file, serialiseNote({ frontmatter, auto: notice, human: parsed.human }));
    marked++;
  }

  return marked;
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(abs)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * Notes first, then the index. A scan that dies in between leaves notes the
 * index has not caught up with, which the next scan rewrites; the other order
 * leaves an index announcing nodes whose notes were never written, and every
 * reader of the vault believes the index.
 */
export async function saveMemory(memory: ProjectMemory): Promise<{ notes: number; stale: number }> {
  const { written, stale } = await saveNotes(memory);
  await saveIndex(memory);
  return { notes: written, stale };
}
