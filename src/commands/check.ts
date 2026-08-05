/**
 * `check` — the CI gate.
 *
 * Everything else in this tool informs a person. This one blocks a merge, so it
 * is deliberately narrow: it says what is wrong, in which category, and exits
 * non-zero. No prose, no suggestions, nothing that needs interpreting at 2am
 * when a pipeline is red.
 *
 * The default is to fail only on `drift` and `auth` — the two categories that
 * mean something is actually broken rather than merely worth knowing. A team
 * that wants the rest opts in.
 */

import * as path from 'node:path';
import { tryLoadMemory } from '../store/vault.js';
import { signals, SIGNAL_CATEGORIES, type Signal, type SignalCategory } from '../core/query.js';
import { out, dim, bold, green, yellow, red, warn, note } from '../ui/out.js';

export interface CheckOptions {
  cwd: string;
  failOn?: string;
  json?: boolean;
  /** Include `info` signals, not just warnings. */
  all?: boolean;
}

const DEFAULT_FAIL_ON: SignalCategory[] = ['drift', 'auth'];

export async function runCheck(options: CheckOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const memory = await tryLoadMemory(root);

  if (!memory || memory.nodes.length === 0) {
    warn('No memory to check. Run `stellar-memory scan` first.');
    process.exitCode = 2; // distinct from "checks failed"
    return;
  }

  const requested = parseCategories(options.failOn);
  if (requested.invalid.length > 0) {
    warn(
      `Unknown categor${requested.invalid.length === 1 ? 'y' : 'ies'}: ${requested.invalid.join(', ')}. ` +
        `Valid: ${SIGNAL_CATEGORIES.join(', ')}.`,
    );
    process.exitCode = 2;
    return;
  }

  const failOn = requested.categories.length > 0 ? requested.categories : DEFAULT_FAIL_ON;
  const all = signals(memory).filter((s) => options.all || s.severity === 'warn');
  const failing = all.filter((s) => failOn.includes(s.category));
  const passing = all.filter((s) => !failOn.includes(s.category));

  if (options.json) {
    out(
      JSON.stringify(
        {
          ok: failing.length === 0,
          failed_on: failOn,
          failing,
          other: passing,
        },
        null,
        2,
      ),
    );
    process.exitCode = failing.length === 0 ? 0 : 1;
    return;
  }

  if (failing.length === 0) {
    out(`${green('✔')} ${bold('No blocking issues')} ${dim(`(checked: ${failOn.join(', ')})`)}`);
    if (passing.length > 0) {
      out();
      out(dim(`  ${passing.length} other finding${passing.length === 1 ? '' : 's'} not checked:`));
      for (const signal of passing) out(dim(`    ${signal.category.padEnd(6)} ${signal.message}`));
    }
    process.exitCode = 0;
    return;
  }

  out(
    `${red('✖')} ${bold(`${failing.length} blocking issue${failing.length === 1 ? '' : 's'}`)} ` +
      dim(`(checked: ${failOn.join(', ')})`),
  );
  out();
  for (const signal of failing) {
    out(`  ${red(signal.category.padEnd(6))} ${signal.message}`);
  }
  if (passing.length > 0) {
    out();
    out(dim(`  ${passing.length} further finding${passing.length === 1 ? '' : 's'} outside the checked categories.`));
  }
  out();
  note(dim('  Categories: ' + SIGNAL_CATEGORIES.join(', ')));
  process.exitCode = 1;
}

function parseCategories(raw: string | undefined): {
  categories: SignalCategory[];
  invalid: string[];
} {
  if (!raw) return { categories: [], invalid: [] };
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  if (parts.includes('all')) return { categories: [...SIGNAL_CATEGORIES], invalid: [] };

  const categories: SignalCategory[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if ((SIGNAL_CATEGORIES as string[]).includes(part)) categories.push(part as SignalCategory);
    else invalid.push(part);
  }
  return { categories, invalid };
}

export type { Signal };
