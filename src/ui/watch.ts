/**
 * File watching for `stellar-memory ui`.
 *
 * Two watches, deliberately kept apart and never wired to each other:
 *
 *   - the vault, which decides when an open window reloads;
 *   - the Rust sources, which decide when `--watch` runs another scan.
 *
 * A scan writes the vault, the vault watch notices, the window reloads. That is
 * a chain and not a cycle, and it stays one because nothing on the `ui` path
 * writes to the project: the page is a string in memory, not a file somewhere
 * the watcher would then see. That is structural, rather than an ignore-list
 * somebody eventually gets wrong.
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { VAULT_DIR } from '../store/vault.js';

export interface Watcher {
  close(): void;
}

/** Directories that hold no sources and would drown the watcher in events. */
const SKIP = new Set(['target', 'node_modules', 'dist', VAULT_DIR]);

/** Files whose contents can change what a scan produces. */
function isSource(name: string): boolean {
  return name.endsWith('.rs') || name === 'Cargo.toml' || name === 'Cargo.lock';
}

/**
 * Watch the vault for the index the page is drawn from.
 *
 * Non-recursive on purpose. `index.json` sits directly in this directory and is
 * the only file the page is built from; `notes/` holds one Markdown file per
 * node and every one of them is rewritten on each scan, which would be a burst
 * of events carrying a signal we already have.
 */
export function watchVault(root: string, onChange: () => void): Watcher {
  const fire = debounce(120, onChange);

  const watcher = fs.watch(path.join(root, VAULT_DIR), { persistent: true }, (_event, filename) => {
    // filename is null on some platforms and event types; when we cannot tell
    // what changed, assume it mattered.
    if (filename === null || String(filename) === 'index.json') fire();
  });

  // The directory being replaced under us ends the watch. The server keeps
  // serving the page it already has rather than taking the window down.
  watcher.on('error', () => watcher.close());

  return {
    close() {
      fire.cancel();
      watcher.close();
    },
  };
}

export interface SourceWatchOptions {
  root: string;
  onChange: () => void;
  /** Long enough to absorb a save plus whatever the editor does after it. */
  debounceMs?: number;
  /** Reported rather than swallowed, so the terminal never overstates coverage. */
  onWarning?: (message: string) => void;
}

/**
 * Watch the Rust sources, one non-recursive watcher per directory.
 *
 * `fs.watch(dir, { recursive: true })` would be shorter, but it is not available
 * across the whole of the Node 20 line this package supports — on Linux it
 * arrived partway through 20.x, and before that the call throws. The stronger
 * reason is that a recursive watch at the repo root also wakes us for every file
 * cargo writes under `target/`, which is most of the files in the project.
 */
export function watchSources(options: SourceWatchOptions): Watcher {
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;

  const fire = debounce(options.debounceMs ?? 300, options.onChange);
  // A new module directory only announces itself as an event on its parent, so
  // rebuilding the watcher set is its own, slower, trigger.
  const resync = debounce(600, () => void sync());

  const sync = async (): Promise<void> => {
    if (closed) return;

    const { dirs, truncated } = await watchableDirs(options.root);
    /*
     * close() may have run while we were walking the tree. Installing watchers
     * now would leave handles nobody holds a reference to and nobody ever
     * closes, and the process would then sit there after Ctrl+C with no visible
     * reason why.
     */
    if (closed) return;

    if (truncated) {
      options.onWarning?.(
        `Watching the first ${dirs.size} source directories only; changes deeper in the tree will not trigger a rescan.`,
      );
    }

    for (const [dir, watcher] of watchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }

    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: true }, (_event, filename) => {
          if (filename === null || isSource(String(filename))) fire();
          else resync();
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // Raced with a delete, or not readable. Neither is worth stopping for.
      }
    }
  };

  void sync();

  return {
    close() {
      closed = true;
      fire.cancel();
      resync.cancel();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

/**
 * Trailing-edge debounce. One `writeFile` produces two `change` events on
 * Windows, and an editor that saves to a temp file and renames produces more, so
 * the interesting moment is when the events stop rather than when they start.
 *
 * The timer is unref'd: a pending debounce must never be the reason Ctrl+C takes
 * an extra 300ms, and the server holds the loop open anyway.
 */
export function debounce(ms: number, fn: () => void): { (): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;

  const call = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
    timer.unref();
  };

  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return call;
}

/**
 * Never run `task` twice at once. A change that lands mid-run queues exactly one
 * more run, not one per change, which is what a burst of saves would otherwise
 * buy. `onError` makes a failure visible without letting it escape: a rescan
 * that throws because a contract is half-edited is the normal case during a live
 * demo, and it must not take the server down with it.
 */
export function serialised(task: () => Promise<void>, onError?: (error: unknown) => void): () => void {
  let running = false;
  let queued = false;

  const run = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };

  return () => void run();
}

/**
 * Every directory worth a watcher: the whole tree minus the parts that never
 * hold sources.
 *
 * Watching only the directories that already contain a `.rs` file is the
 * tempting shortcut and it is wrong twice over. A new contract directory starts
 * empty, so it would never be watched; and the directory that would have
 * reported its creation — `contracts/`, which holds only subdirectories — would
 * not be watched either. Watch the structure and let the event filter decide
 * what is interesting.
 */
async function watchableDirs(
  root: string,
  limit = 1_024,
): Promise<{ dirs: Set<string>; truncated: boolean }> {
  const dirs = new Set<string>([root]);
  const queue: string[] = [root];
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift()!;

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // The dotted rule covers .git and the vault; SKIP covers the rest.
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      if (dirs.size >= limit) {
        truncated = true;
        break;
      }
      const child = path.join(dir, entry.name);
      dirs.add(child);
      queue.push(child);
    }
  }

  return { dirs, truncated };
}
