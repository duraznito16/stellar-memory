#!/usr/bin/env node
/**
 * stellar-memory — a persistent memory layer for Stellar and Soroban projects.
 *
 * Installed on PATH as `stellar-memory`, which the Stellar CLI also exposes as
 * `stellar memory` through its plugin mechanism.
 */

import { Command } from 'commander';
import { fail } from './ui/out.js';
import { runInit } from './commands/init.js';
import { runScan } from './commands/scan.js';
import { runResume } from './commands/resume.js';
import { runExplain } from './commands/explain.js';
import { runGraph } from './commands/graph.js';
import { runCheck } from './commands/check.js';
import { runMcp } from './commands/mcp.js';

const program = new Command();

program
  .name('stellar-memory')
  .description(
    'A persistent memory layer for Stellar projects.\n' +
      'Scans a repository, links its contracts to what is actually deployed,\n' +
      'and answers questions about it — for you and for your agents.',
  )
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'run as if started in <dir>', process.cwd());

program
  .command('init')
  .description('create the memory vault for this project')
  .option('--name <name>', 'project name (defaults to the directory name)')
  .option('--force', 'overwrite an existing vault', false)
  .option('--with-agents', 'also scaffold a team of AI agents wired to this project', false)
  .action(async (opts) => runInit({ ...globals(), ...opts }));

program
  .command('scan')
  .description('analyse the repository and update the memory')
  .option('--offline', 'skip every network and CLI call', false)
  .option('-n, --network <name...>', 'networks to check for deployments', ['testnet', 'mainnet'])
  .option('-q, --quiet', 'suppress progress output', false)
  .action(async (opts) => runScan({ ...globals(), ...opts }));

program
  .command('resume')
  .description('recover context: what this project is, and what moved while you were away')
  .option('--json', 'emit the report as JSON', false)
  .action(async (opts) => runResume({ ...globals(), ...opts }));

program
  .command('explain [question...]')
  .description('ask about the project; without a question, print an overview')
  .option('--ai', 'use the AI layer for a prose answer (needs ANTHROPIC_API_KEY)', false)
  .option('--json', 'emit structured results as JSON', false)
  .action(async (question: string[], opts) =>
    runExplain({ ...globals(), ...opts, question: question.join(' ') }),
  );

program
  .command('graph')
  .description('show how the project fits together')
  .option('-f, --format <format>', 'tree | mermaid | dot | json | html', 'tree')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .option('--focus <id>', 'centre the graph on one node')
  .action(async (opts) => runGraph({ ...globals(), ...opts }));

program
  .command('check')
  .description('fail with a non-zero exit code when the project has blocking issues (for CI)')
  .option(
    '--fail-on <categories>',
    'comma-separated: drift, ttl, auth, abi, value, tests, or "all"',
    'drift,auth',
  )
  .option('--all', 'also consider informational findings', false)
  .option('--json', 'emit the result as JSON', false)
  .action(async (opts) => runCheck({ ...globals(), ...opts }));

program
  .command('mcp')
  .description('serve the memory to AI agents over MCP (stdio)')
  .action(async (opts) => runMcp({ ...globals(), ...opts }));

function globals(): { cwd: string } {
  const opts = program.opts<{ cwd: string }>();
  return { cwd: opts.cwd ?? process.cwd() };
}

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
