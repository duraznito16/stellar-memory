/**
 * `ui` — the graph in a window, kept current.
 *
 * `graph --format html` writes a file and stops there, which leaves the reader
 * to find it, open it, and re-run the command every time the code moves. This
 * renders the same page, serves it from a loopback socket, opens a window on it,
 * and reloads that window whenever the vault changes. With `--watch` it also
 * rescans on a source edit, so editing a contract updates the picture.
 *
 * Nothing here writes the page to disk. That is what keeps the reload loop a
 * chain rather than a cycle: the only thing this process writes to the project
 * is the vault, and only when `--watch` asked for a scan.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryLoadMemory } from '../store/vault.js';
import { signals } from '../core/query.js';
import { renderGraphHtml } from '../store/html.js';
import type { ProjectMemory } from '../core/types.js';
import { runScan } from './scan.js';
import { HTML_FILE } from './graph.js';
import { onShutdown, startUiServer, type RenderedPage, type UiServer } from '../ui/serve.js';
import { openAppWindow, type OpenResult } from '../ui/open.js';
import { serialised, watchSources, watchVault, type Watcher } from '../ui/watch.js';
import { out, note, success, warn, fail, dim, bold, cyan } from '../ui/out.js';

export interface UiOptions {
  cwd: string;
  port?: number;
  /** Commander's `--no-open` leaves this true unless the flag is given. */
  open?: boolean;
  watch?: boolean;
  once?: boolean;
}

export async function runUi(options: UiOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const memory = await tryLoadMemory(root);
  if (!memory || memory.nodes.length === 0) {
    warn('Nothing to draw yet. Run `stellar-memory scan`.');
    process.exitCode = 1;
    return;
  }

  if (options.once) {
    await runOnce(root, memory, options);
    return;
  }

  /*
   * Re-read the vault on every render rather than closing over the memory
   * loaded above: a scan in another terminal is then visible to an open window,
   * which is the same rule the MCP server follows.
   *
   * The stamp comes from what is drawn, not from a counter and not from the
   * whole vault, so it changes exactly when the picture does — and a window that
   * reconnects to a restarted server reloads only if the project moved while it
   * was away.
   *
   * Hashing the memory would have been shorter and would have been wrong: every
   * scan appends a timestamped record to `scans`, so the stamp would change on
   * every save with `--watch`, reloading a window whose contents are identical
   * and printing a line claiming a change nobody made. The signals go into the
   * hash beside the nodes and edges because they are drawn too — the rings, and
   * the list in the panel — and they are already computed here.
   */
  const render = async (): Promise<RenderedPage> => {
    const current = await tryLoadMemory(root);
    if (!current || current.nodes.length === 0) throw new Error('the vault has no nodes to draw');
    const found = signals(current);
    const drawn = { project: current.project, nodes: current.nodes, edges: current.edges, signals: found };
    const stamp = createHash('sha1').update(JSON.stringify(drawn)).digest('hex').slice(0, 12);
    return { html: renderGraphHtml(current, found, { live: { stamp } }), stamp };
  };

  let server: UiServer;
  try {
    server = await startUiServer({ port: options.port, render });
  } catch (error) {
    fail(describe(error));
    process.exitCode = 1;
    return;
  }

  const watchers: Watcher[] = [];
  try {
    watchers.push(watchVault(root, () => void reload(server)));
  } catch {
    warn('Could not watch the vault; an open window will not refresh on its own.');
  }

  if (options.watch) {
    const rescan = serialised(
      async () => {
        server.announce('scanning');
        // Offline: a scan on every save must not reach the network, and it is
        // the shape of the code that changed anyway. The summary belongs to
        // someone who ran `scan` on purpose; here it would bury the one line
        // that matters, once per keystroke.
        await runScan({ cwd: root, offline: true, quiet: true, summary: false });
        // Only on the way out of a scan that finished. Announcing this from a
        // `finally` would put the window back to its steady state after a
        // failure too, over a graph that no longer matches the source.
        server.announce('scanned');
      },
      (error) => {
        server.announce('scan-failed');
        warn(`Rescan failed, still serving the last graph that worked: ${describe(error)}`);
      },
    );
    watchers.push(watchSources({ root, onChange: rescan, onWarning: warn }));
  }

  success(`Serving ${bold(memory.project.name)}`);
  out();
  out(`  ${bold(cyan(server.url))}`);
  out();
  if (options.watch) note(dim('  Watching Rust sources; an edit triggers an offline rescan.'));
  note(dim('  Ctrl+C to stop.'));

  // The address is on screen before anything is launched, so it is there even if
  // opening a window hangs.
  if (options.open === false) {
    note(dim('  Not opening a window (--no-open).'));
  } else {
    await openAndConfirm(server);
  }

  onShutdown(async () => {
    for (const watcher of watchers) watcher.close();
    await server.close();
    note(dim('Stopped.'));
  });
}

/** The current behaviour of `graph --format html`, with the window opened for you. */
async function runOnce(root: string, memory: ProjectMemory, options: UiOptions): Promise<void> {
  if (options.watch || options.port !== undefined) {
    warn('`--once` writes a file and opens it, with no server; --watch and --port do nothing here.');
  }

  const file = path.join(root, HTML_FILE);
  // No live options, so this is byte-for-byte what `graph --format html` writes:
  // self-contained, and with no reference to a server that will not be there.
  await fs.writeFile(file, renderGraphHtml(memory, signals(memory)), 'utf8');
  success(`Wrote ${bold(path.relative(root, file) || file)}`);
  note(dim('  It needs no server and no network, so it keeps working once this exits.'));

  if (options.open === false) {
    note(dim('  Not opening a window (--no-open).'));
    return;
  }
  report(await openAppWindow(pathToFileURL(file).href), 'Open the file above.');
}

async function reload(server: UiServer): Promise<void> {
  try {
    if (!(await server.refresh())) return;
    const windows = server.clients;
    note(dim(`  Graph updated — reloaded ${windows} window${windows === 1 ? '' : 's'}.`));
  } catch (error) {
    // A half-written index.json is a moment, not a state. Keep showing the last
    // page that was true and wait for the next event.
    note(dim(`  Vault not readable yet (${describe(error)}); keeping the current view.`));
  }
}

/**
 * Open a window, then check whether one actually appeared.
 *
 * A launcher can only report that the exec resolved — Chrome exits 0 either way,
 * including when it hands the URL to an instance that is already running. A
 * request arriving is the only evidence a window exists, and claiming one
 * without that evidence is exactly the kind of thing this tool does not do.
 */
async function openAndConfirm(server: UiServer, within = 3_000): Promise<void> {
  const result = await openAppWindow(server.url);
  if (result.method === 'none') {
    report(result, 'Open the address above.');
    return;
  }

  const deadline = Date.now() + within;
  while (!server.served && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  if (server.served) {
    report(result, '');
    return;
  }
  warn('A browser was launched but has not asked for the page. Open the address above.');
}

function report(result: OpenResult, fallback: string): void {
  if (result.method === 'app-window') success('Opened a window.');
  else if (result.method === 'default-browser') success(`Opened your default browser (${result.reason}).`);
  else warn(`Could not open a browser (${result.reason}). ${fallback}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
