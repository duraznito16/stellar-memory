/**
 * The CI gate, exercised the way CI will: run the built binary, read the exit
 * code. A gate that reports correctly but exits zero is worse than no gate.
 *
 * The paths that refuse to run are here for the same reason. A runner acts on
 * stdout and an exit code and has nothing else, so a refusal has to be as
 * readable as a result — and a flag that names a file has to write that file
 * or say why it did not.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const demo = path.join(repoRoot, 'demo', 'private-payroll');
const entry = path.join(repoRoot, 'dist', 'index.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const check = (...args: string[]): Promise<Run> => cli('--cwd', demo, 'check', ...args);

test('exits non-zero when a checked category has findings', async () => {
  // The demo's initializers are genuinely unguarded, so the default gate fails
  // on `auth` regardless of whether the vault has seen the network.
  const run = await check();
  assert.equal(run.code, 1, 'a failing gate must exit 1');
  assert.match(run.stdout, /blocking issue/);
});

test('reports categories separately and machine-readably', async () => {
  // Gate on `auth` rather than `drift`: auth findings are derived from source
  // alone, so this holds whether the committed vault was last scanned online or
  // offline. Drift only exists after a networked scan, and a unit test that
  // depends on it passes or fails according to how someone last ran the tool.
  const run = await check('--fail-on', 'auth', '--json');
  assert.equal(run.code, 1);

  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    failed_on: string[];
    failing: { category: string; message: string }[];
    other: { category: string }[];
  };

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.failed_on, ['auth']);
  assert.ok(parsed.failing.length > 0);
  assert.ok(
    parsed.failing.every((s) => s.category === 'auth'),
    'only the requested category may fail the gate',
  );
  assert.ok(
    parsed.other.length > 0 && parsed.other.every((s) => s.category !== 'auth'),
    'findings outside the gate are still reported, and are not the gated category',
  );
});

test('exits zero when the checked category is clean', async () => {
  // The demo has no ABI mismatch, so gating on `abi` alone passes.
  const run = await check('--fail-on', 'abi', '--json');
  assert.equal(run.code, 0, 'a clean gate must exit 0');
  const parsed = JSON.parse(run.stdout) as { ok: boolean; failing: unknown[] };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.failing.length, 0);
});

test('rejects an unknown category instead of silently passing', async () => {
  // Exiting 0 on a typo would make a pipeline green for the wrong reason.
  const run = await check('--fail-on', 'nonsense');
  assert.equal(run.code, 2, 'a misconfigured gate is distinct from a failing one');
});

/* ------------------------------------------------------------------ *
 * Exit 2, read by a machine
 * ------------------------------------------------------------------ */

test('a runner with no vault is told so in the format it asked for', async () => {
  // `check --json | jq .ok` used to find stdout empty here and die on it, which
  // reads exactly like a crash.
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-check-'));
  try {
    const run = await cli('--cwd', bare, 'check', '--fail-on', 'drift', '--json');
    assert.equal(run.code, 2, 'nothing to check is a misconfigured gate, not a failing one');

    const parsed = JSON.parse(run.stdout) as {
      ok: boolean;
      error: string;
      message: string;
      failing: unknown[];
    };
    assert.equal(parsed.ok, false, 'nothing was checked, so nothing passed');
    assert.equal(parsed.error, 'no_memory');
    assert.match(parsed.message, /scan/, 'and what to do about it');
    assert.deepEqual(parsed.failing, [], 'the keys a clean run has are still there to iterate');
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test('a mistyped category comes back as data, naming what was mistyped', async () => {
  const run = await check('--fail-on', 'drfit,auth', '--json');
  assert.equal(run.code, 2, 'one bad category misconfigures the whole gate');

  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    error: string;
    invalid: string[];
    valid: string[];
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'unknown_category', 'distinguishable from a missing vault');
  assert.deepEqual(parsed.invalid, ['drfit'], 'only the part that was wrong');
  assert.ok(parsed.valid.includes('drift'), 'and what it could have been');
});

/* ------------------------------------------------------------------ *
 * Where `-C` is allowed to sit
 * ------------------------------------------------------------------ */

test('-C is read on either side of the subcommand', async () => {
  const leading = await cli('--cwd', demo, 'check', '--fail-on', 'abi', '--json');
  const trailing = await cli('check', '-C', demo, '--fail-on', 'abi', '--json');

  assert.equal(trailing.code, leading.code, 'the position of the flag is not part of the answer');
  assert.deepEqual(JSON.parse(trailing.stdout), JSON.parse(leading.stdout));

  // The README wires an MCP server with this flag, so the help of the command
  // being wired is where someone will look for it.
  const help = await cli('scan', '--help');
  assert.match(help.stdout, /-C, --cwd <dir>/);
});

/* ------------------------------------------------------------------ *
 * `graph`, whose output is an artifact something else consumes
 * ------------------------------------------------------------------ */

let project: string;

before(async () => {
  // The real vault, in a directory a test may write into: `--out` resolves
  // against the project root, and the demo's is committed.
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-graph-'));
  await fs.mkdir(path.join(project, '.stellar-memory'));
  await fs.copyFile(
    path.join(demo, '.stellar-memory', 'index.json'),
    path.join(project, '.stellar-memory', 'index.json'),
  );
});

after(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

test('graph --focus writes the file it was given, narrowed to the focus', async () => {
  // It used to print the tree, write nothing, and exit 0 — so a documentation
  // script kept publishing whatever artifact was there from last time.
  const run = await cli(
    '--cwd', project, 'graph',
    '--focus', 'contract:Treasury',
    '--format', 'json',
    '--out', 'treasury.json',
  );
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '', 'the artifact is the file, not the terminal');

  const written = JSON.parse(
    await fs.readFile(path.join(project, 'treasury.json'), 'utf8'),
  ) as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
  const whole = JSON.parse(
    await fs.readFile(path.join(project, '.stellar-memory', 'index.json'), 'utf8'),
  ) as { nodes: unknown[]; edges: { from: string; to: string }[] };

  const ids = new Set(written.nodes.map((n) => n.id));
  assert.ok(ids.has('contract:Treasury'));
  assert.ok(ids.has('contract:Payroll'), 'what points at the focus is part of it');
  assert.ok(written.nodes.length < whole.nodes.length, 'a focus is narrower than the project');
  assert.ok(
    written.nodes.every(
      (n) =>
        n.id === 'contract:Treasury' ||
        whole.edges.some(
          (e) =>
            (e.from === n.id && e.to === 'contract:Treasury') ||
            (e.to === n.id && e.from === 'contract:Treasury'),
        ),
    ),
    'and nothing further than one edge from it',
  );
  assert.ok(
    written.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    'no edge may point at a node the file does not contain',
  );
});

test('graph --focus writes the default format too, without the colour', async () => {
  const run = await cli('--cwd', project, 'graph', '--focus', 'contract:Treasury', '--out', 'treasury.txt');
  assert.equal(run.code, 0);

  const text = await fs.readFile(path.join(project, 'treasury.txt'), 'utf8');
  assert.match(text, /Treasury/);
  assert.match(text, /Pointed to by/, 'the focus view, not the whole tree');
  // picocolors decides from the terminal — and on Windows it decides yes even
  // when stdout is a pipe. A file full of escapes is a file nobody can diff.
  assert.ok(!text.includes(String.fromCharCode(27)), 'terminal colour does not belong in a file');
});

test('graph --focus refuses the one format that cannot carry it', async () => {
  const run = await cli('--cwd', project, 'graph', '--focus', 'contract:Treasury', '--format', 'html');
  assert.notEqual(run.code, 0, 'drawing the whole project instead is the failure this replaces');
  assert.match(run.stderr, /--focus cannot be drawn as a page/);
  // The page's default destination is the file `ui --once` writes and a project
  // commits, so a refusal that still wrote it would be the worse outcome.
  await assert.rejects(fs.access(path.join(project, 'stellar-memory-graph.html')));
});
