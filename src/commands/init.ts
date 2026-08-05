import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyMemory, isInitialised, saveIndex, vaultPath, VAULT_DIR } from '../store/vault.js';
import { out, success, warn, dim, bold } from '../ui/out.js';

export interface InitOptions {
  cwd: string;
  name?: string;
  force?: boolean;
  /** Also scaffold a team of Claude Code subagents wired to this project's memory. */
  withAgents?: boolean;
}

const README = `# Project memory

This folder is a **stellar-memory** vault: a persistent, human-readable record of
what this Stellar project is and how its parts relate.

- \`index.json\` — the knowledge graph, for tooling and agents.
- \`notes/\` — one Markdown note per contract, function, deployment, task and doc.

Notes are also a valid Obsidian vault. Open this folder in Obsidian to see the
project as a graph.

## Editing

Every note has a machine-owned block:

\`\`\`
<!-- stellar-memory:auto -->
...regenerated on every scan...
<!-- /stellar-memory:auto -->
\`\`\`

Anything outside that block is yours and is never overwritten. Use it to record
the reasoning that source code cannot hold: why a design was chosen, what was
tried and rejected, what to be careful about.

Commit this folder. The value compounds as the project ages.
`;

export async function runInit(options: InitOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const name = options.name ?? path.basename(root);

  if ((await isInitialised(root)) && !options.force) {
    warn(`This project already has a vault at ${VAULT_DIR}/. Use --force to start over.`);
    return;
  }

  const dir = vaultPath(root);
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), README, 'utf8');
  await saveIndex(emptyMemory(name, root));

  success(`Created ${VAULT_DIR}/ for ${bold(name)}`);

  if (options.withAgents) {
    const { agents, mcp } = await scaffoldAgents(root);
    if (agents > 0) {
      success(`Wrote ${bold(String(agents))} agents to .claude/agents/`);
      if (mcp) success('Wrote .mcp.json so they can reach this project\'s memory');
    }
  }

  out();
  out(`  ${dim('Next:')} stellar-memory scan`);
  out(`  ${dim('Then:')} stellar-memory resume`);
  out();
}

const MCP_CONFIG = {
  mcpServers: {
    'stellar-memory': {
      command: 'stellar-memory',
      args: ['mcp'],
    },
  },
};

/**
 * Copy the agent team into the developer's own project.
 *
 * The memory is only half the value; the other half is a set of agents that
 * know how to use it — where to start, what to check before editing, and when
 * to stop. Shipping them into the scanned project is what turns this from a
 * tool an agent *can* query into one an agent already knows how to work with.
 */
async function scaffoldAgents(root: string): Promise<{ agents: number; mcp: boolean }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/commands/init.js -> <package root>/templates/agents
  const source = path.resolve(here, '..', '..', 'templates', 'agents');

  let names: string[];
  try {
    names = (await fs.readdir(source)).filter((n) => n.endsWith('.md'));
  } catch {
    warn('Agent templates were not found in this installation; skipped.');
    return { agents: 0, mcp: false };
  }

  const target = path.join(root, '.claude', 'agents');
  await fs.mkdir(target, { recursive: true });

  let written = 0;
  for (const name of names) {
    const destination = path.join(target, name);
    // Never clobber an agent the developer has customised.
    try {
      await fs.access(destination);
      continue;
    } catch {
      // absent, so write it
    }
    await fs.copyFile(path.join(source, name), destination);
    written++;
  }

  // The agents are useless without a route to the memory, so configure it —
  // but an existing .mcp.json is the developer's, not ours to rewrite.
  const mcpPath = path.join(root, '.mcp.json');
  let wroteMcp = false;
  try {
    await fs.access(mcpPath);
  } catch {
    await fs.writeFile(mcpPath, JSON.stringify(MCP_CONFIG, null, 2) + '\n', 'utf8');
    wroteMcp = true;
  }

  return { agents: written, mcp: wroteMcp };
}
