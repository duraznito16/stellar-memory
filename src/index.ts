#!/usr/bin/env node
/**
 * stellar-memory — a persistent memory layer for Stellar and Soroban projects.
 *
 * Installed on PATH as `stellar-memory`, which the Stellar CLI also exposes as
 * `stellar memory` through its plugin mechanism.
 */

import { Command } from 'commander';
import { VERSION } from './core/version.js';
import { fail } from './ui/out.js';
import { runInit } from './commands/init.js';
import { runScan } from './commands/scan.js';
import { runResume } from './commands/resume.js';
import { runExplain } from './commands/explain.js';
import { runGraph } from './commands/graph.js';
import { runUi } from './commands/ui.js';
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
  .version(VERSION)
  .option('-C, --cwd <dir>', 'run as if started in <dir>');

program
  .command('init')
  .description('create the memory vault for this project')
  .option('--name <name>', 'project name (defaults to the directory name)')
  .option('--force', 'overwrite an existing vault', false)
  .option('--with-agents', 'also scaffold a team of AI agents wired to this project', false)
  .action(async (opts, command: Command) => runInit({ ...globals(command), ...opts }));

program
  .command('scan')
  .description('analyse the repository and update the memory')
  .option('--offline', 'skip every network and CLI call', false)
  .option('-n, --network <name...>', 'networks to check for deployments', ['testnet', 'mainnet'])
  .option('-q, --quiet', 'suppress progress output', false)
  .action(async (opts, command: Command) => runScan({ ...globals(command), ...opts }));

program
  .command('resume')
  .description('recover context: what this project is, and what moved while you were away')
  .option('--json', 'emit the report as JSON', false)
  .action(async (opts, command: Command) => runResume({ ...globals(command), ...opts }));

program
  .command('explain [question...]')
  .description('ask about the project; without a question, print an overview')
  .option('--ai', 'use the AI layer for a prose answer (needs ANTHROPIC_API_KEY)', false)
  .option('--json', 'emit structured results as JSON', false)
  .action(async (question: string[], opts, command: Command) =>
    runExplain({ ...globals(command), ...opts, question: question.join(' ') }),
  );

program
  .command('graph')
  .description('show how the project fits together')
  .option('-f, --format <format>', 'tree | mermaid | dot | json | html', 'tree')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .option('--focus <id>', 'centre the graph on one node')
  .action(async (opts, command: Command) => runGraph({ ...globals(command), ...opts }));

program
  .command('ui')
  .description('open the graph in a window and keep it current')
  .option('-p, --port <number>', 'serve on this port instead of one chosen for you', toPort)
  .option('--no-open', 'print the address without opening a window')
  .option('--watch', 're-scan offline when a Rust source changes', false)
  .option('--once', 'write the self-contained file and open that, with no server', false)
  .action(async (opts, command: Command) => runUi({ ...globals(command), ...opts }));

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
  .action(async (opts, command: Command) => runCheck({ ...globals(command), ...opts }));

program
  .command('mcp')
  .description('serve the memory to AI agents over MCP (stdio)')
  .action(async (opts, command: Command) => runMcp({ ...globals(command), ...opts }));

// Declared here as well as on `program`. The parser already lifts a parent
// option out of anywhere in the argv, but only the command that declares one
// lists it in its own `--help` — and `--cwd` is the flag the README wires an
// MCP server with, so `scan --help` is where someone will go looking for it.
for (const command of program.commands) {
  command.option('-C, --cwd <dir>', 'run as if started in <dir>');
}

function globals(command: Command): { cwd: string } {
  // In optsWithGlobals the outer command wins, which is why the one on
  // `program` carries no default: it would beat a `-C` typed after the
  // subcommand and silently run in the wrong directory.
  const opts = command.optsWithGlobals<{ cwd?: string }>();
  return { cwd: opts.cwd ?? process.cwd() };
}

/** A port that is not a port must fail here, not as a confusing listen error. */
function toPort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port needs a whole number from 0 to 65535, not "${raw}".`);
  }
  return port;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
