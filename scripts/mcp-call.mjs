#!/usr/bin/env node
/**
 * Call the stellar-memory MCP server from a shell.
 *
 * The server speaks JSON-RPC over stdio, which is right for an agent client and
 * awkward for a person or a script. This is the thin bridge: it starts the
 * server, makes one call, prints the result, and exits.
 *
 *   node scripts/mcp-call.mjs --list
 *   node scripts/mcp-call.mjs project_overview
 *   node scripts/mcp-call.mjs search_memory '{"query":"treasury"}'
 *   node scripts/mcp-call.mjs describe_node '{"id":"contract:Payroll"}' --cwd demo/private-payroll
 *
 * Useful for demos, for shell pipelines, and for checking what an agent will
 * actually receive before trusting a tool description.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') flags.list = true;
    else if (arg === '--cwd') flags.cwd = argv[++i];
    else if (arg === '--raw') flags.raw = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const USAGE = `stellar-memory MCP client

  node scripts/mcp-call.mjs --list
  node scripts/mcp-call.mjs <tool> [json-arguments] [--cwd <project>] [--raw]

Options
  --list   list the tools the server advertises, with their descriptions
  --cwd    the project whose memory to serve (default: demo/private-payroll)
  --raw    print the raw content blocks instead of just the text
`;

const { positional, flags } = parseArgs(process.argv.slice(2));

if (flags.help || (!flags.list && positional.length === 0)) {
  process.stdout.write(USAGE);
  process.exit(flags.help ? 0 : 1);
}

const project = path.resolve(repoRoot, flags.cwd ?? path.join('demo', 'private-payroll'));
const entry = path.join(repoRoot, 'dist', 'index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, '--cwd', project, 'mcp'],
});

const client = new Client({ name: 'mcp-call', version: '1.0.0' });

try {
  await client.connect(transport);

  if (flags.list) {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      process.stdout.write(`\n${tool.name}\n  ${(tool.description ?? '').replace(/\s+/g, ' ')}\n`);
      const props = tool.inputSchema?.properties ?? {};
      for (const [name, schema] of Object.entries(props)) {
        process.stdout.write(`    ${name}: ${schema.description ?? schema.type ?? ''}\n`);
      }
    }
    process.stdout.write('\n');
  } else {
    const [name, rawArgs] = positional;
    let args = {};
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch (error) {
        process.stderr.write(`Arguments must be JSON: ${error.message}\n`);
        process.exit(2);
      }
    }

    const result = await client.callTool({ name, arguments: args });
    if (flags.raw) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const text = (result.content ?? [])
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();
      process.stdout.write(text + '\n');
    }
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
