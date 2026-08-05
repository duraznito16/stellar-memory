/**
 * The CI gate, exercised the way CI will: run the built binary, read the exit
 * code. A gate that reports correctly but exits zero is worse than no gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
}

async function check(...args: string[]): Promise<Run> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [entry, '--cwd', demo, 'check', ...args],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '' };
  }
}

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
