/**
 * Repository traversal.
 *
 * Deliberately conservative: a scan runs on a developer's working tree and must
 * never take long enough that they stop running it. Build outputs and vendored
 * code are skipped, and oversized files are recorded but not read.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  '.stellar-memory',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/** Files larger than this are catalogued but never read into memory. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

export interface FileEntry {
  /** Repo-relative, always POSIX-separated so vaults are portable across OSes. */
  rel: string;
  abs: string;
  size: number;
  ext: string;
}

export interface WalkResult {
  files: FileEntry[];
  /** Directories skipped, for reporting ("skipped target/, node_modules/"). */
  skipped: string[];
}

export async function walkRepo(root: string): Promise<WalkResult> {
  const files: FileEntry[] = [];
  const skipped: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not fatal to a scan
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          skipped.push(rel);
          continue;
        }
        await visit(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }

      files.push({ rel, abs, size, ext: path.extname(entry.name).toLowerCase() });
    }
  }

  await visit(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped };
}

export async function readFileSafe(entry: FileEntry): Promise<string | null> {
  if (entry.size > MAX_READ_BYTES) return null;
  try {
    const text = await fs.readFile(entry.abs, 'utf8');
    // Windows editors and PowerShell write UTF-8 with a byte-order mark. A
    // leading BOM makes a TOML parser reject an otherwise valid Cargo.toml, so
    // a manifest authored on Windows would silently drop out of the scan.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
