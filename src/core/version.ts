/**
 * The package version, read from package.json at runtime.
 *
 * It was a literal in two places, and both drifted the moment the package was
 * released: `--version` reported 0.1.0 from a correct 0.2.0 install, which is
 * exactly the sort of thing someone chases for an hour while debugging.
 * One source of truth, resolved from disk.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function read(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/core/version.js -> <package root>/package.json
  const candidates = [
    path.resolve(here, '..', '..', 'package.json'),
    path.resolve(here, '..', '..', '..', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (parsed.name === 'soroban-memory' && parsed.version) return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0-unknown';
}

export const VERSION = read();
