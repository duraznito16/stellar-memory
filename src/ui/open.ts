/**
 * Opening a window on the user's desktop.
 *
 * Nothing here is allowed to throw. The caller is a running HTTP server: a
 * window that fails to open is a nuisance, an unhandled rejection is a dead
 * demo. The trap is that `spawn()` reports a missing binary *asynchronously*, so
 * a try/catch around it does nothing — without an 'error' listener the ENOENT
 * becomes an uncaughtException and takes the server with it.
 *
 * Three tiers, in order: a Chromium `--app=` window, the OS default handler, and
 * giving up honestly. The result says which one happened so the caller can
 * describe what it actually did rather than what it hoped for.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type OpenMethod = 'app-window' | 'default-browser' | 'none';

export interface OpenResult {
  method: OpenMethod;
  /** What was launched, so the caller can report it accurately. */
  via?: string;
  /** Why it fell back or gave up. Never surfaced as an error. */
  reason?: string;
}

export interface OpenOptions {
  /**
   * Give the window its own Chrome profile. Off by default, and not wired to a
   * flag: with a separate profile the spawned browser *is* our child and lives
   * for the window's lifetime, so anything that kills this process tree closes
   * the window too. Handing the URL to an already-running Chrome instead leaves
   * no descendant at all, and a window that survives Ctrl+C is worth more than a
   * clean profile.
   */
  isolateProfile?: boolean;
  width?: number;
  height?: number;
}

/**
 * Chrome drops these when it hands the URL to an instance that is already
 * running, which during a demo is the usual case — so the size is a preference,
 * never a promise. The page is responsive either way.
 */
function appArgs(url: string, options: OpenOptions): string[] {
  const args = [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${options.width ?? 1280},${options.height ?? 860}`,
  ];
  if (options.isolateProfile) {
    const root = process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp';
    args.push(`--user-data-dir=${path.join(root, 'stellar-memory-ui')}`);
  }
  return args;
}

/** Edge installs under Program Files (x86) even on 64-bit Windows. */
function windowsCandidates(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? '';
  const roots = [
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    local ? path.join(local, 'Programs') : '',
    local,
  ].filter(Boolean);
  const relative = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'Chromium\\Application\\chrome.exe',
  ];
  return relative.flatMap((rel) => roots.map((root) => path.join(root, rel)));
}

function darwinCandidates(): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
}

/** Resolved through PATH by spawn, so one that is not installed just fails through. */
function linuxCandidates(): string[] {
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

async function existing(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      found.push(candidate);
    } catch {
      // Not installed here; keep looking.
    }
  }
  return found;
}

/**
 * Backstop for a browser installed somewhere unusual.
 *
 * Match on the REG_SZ type, never on the value name: on this machine — Spanish
 * Windows — `reg query` prints the name as `(Predeterminado)`, so a parser
 * keyed on `(Default)` finds nothing and silently degrades to the default
 * browser on every non-English install.
 */
async function fromRegistry(exe: string): Promise<string | undefined> {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const key of keys) {
    const stdout = await readCommand('reg.exe', ['query', key, '/ve']);
    const file = stdout?.match(/REG_SZ\s+(.+?)\s*$/m)?.[1]?.trim();
    if (!file) continue;
    try {
      await fs.access(file);
      return file;
    } catch {
      // The registry pointed at a stale install.
    }
  }
  return undefined;
}

function readCommand(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const child = spawn(file, args, { windowsHide: true });
      let buffer = '';
      child.stdout?.on('data', (chunk) => (buffer += String(chunk)));
      child.on('error', () => finish(undefined));
      child.on('close', (code) => finish(code === 0 ? buffer : undefined));
      setTimeout(() => {
        child.kill();
        finish(undefined);
      }, 2_000).unref();
    } catch {
      finish(undefined);
    }
  });
}

/** Every Chromium browser worth trying here, best first. */
export async function findChromium(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const direct = await existing(windowsCandidates());
      if (direct.length > 0) return direct;
      const found: string[] = [];
      for (const exe of ['chrome.exe', 'msedge.exe', 'brave.exe']) {
        const hit = await fromRegistry(exe);
        if (hit) found.push(hit);
      }
      return found;
    }
    if (process.platform === 'darwin') return await existing(darwinCandidates());
    return linuxCandidates();
  } catch {
    return [];
  }
}

/**
 * Start a detached process and report whether it got off the ground.
 *
 * The 'error' listener is attached before `unref()` and is the reason a missing
 * browser does not kill the server. Silence for `settleMs` means it started:
 * Chrome legitimately exits 0 straight away when it hands the URL to an
 * instance that is already running.
 */
function launch(file: string, args: string[], settleMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => finish(false));
      // Closing the CLI should leave the window open, so nothing here waits on
      // the child or holds a reference to it.
      child.unref();
      setTimeout(() => finish(true), settleMs).unref();
    } catch {
      finish(false);
    }
  });
}

/**
 * `start` reads a lone quoted argument as the window title, so the empty title
 * is load-bearing. It must stay an argv element: built as a shell string the URL
 * is swallowed as the title and nothing opens.
 */
async function openWithDefaultHandler(url: string): Promise<boolean> {
  if (process.platform === 'win32') {
    if (/[&|<>^"]/.test(url)) return false; // cmd would reinterpret these
    return launch(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', 'start', '""', url]);
  }
  if (process.platform === 'darwin') return launch('open', [url]);
  return launch('xdg-open', [url]);
}

/**
 * Open `url` in a frameless app window, falling back to the default browser and
 * finally to doing nothing. Always resolves, so the caller can print the address
 * and carry on regardless.
 */
export async function openAppWindow(url: string, options: OpenOptions = {}): Promise<OpenResult> {
  try {
    const browsers = await findChromium();
    for (const browser of browsers) {
      if (await launch(browser, appArgs(url, options))) return { method: 'app-window', via: browser };
    }
    if (await openWithDefaultHandler(url)) {
      return {
        method: 'default-browser',
        reason: browsers.length > 0 ? 'the app window did not start' : 'no Chromium browser found',
      };
    }
    return { method: 'none', reason: 'no browser could be launched' };
  } catch (error) {
    return { method: 'none', reason: error instanceof Error ? error.message : String(error) };
  }
}
