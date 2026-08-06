import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tryLoadMemory } from '../store/vault.js';
import {
  DRIFT_LABEL,
  architecture,
  driftState,
  neighbourhood,
  nodesOfKind,
  search,
  signals,
} from '../core/query.js';
import { renderGraphHtml } from '../store/html.js';
import type { DeploymentData, MemoryNode, ProjectMemory } from '../core/types.js';
import { out, note, success, warn, fail, dim, bold, cyan, green, yellow } from '../ui/out.js';

/** Where the page lands when no destination was given. Shared with `ui --once`. */
export const HTML_FILE = 'stellar-memory-graph.html';

export interface GraphOptions {
  cwd: string;
  format?: string;
  focus?: string;
  /** Write to this file instead of stdout. */
  out?: string;
}

export async function runGraph(options: GraphOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const memory = await tryLoadMemory(root);
  if (!memory || memory.nodes.length === 0) {
    warn('Nothing to draw yet. Run `stellar-memory scan`.');
    process.exitCode = 1;
    return;
  }

  const format = (options.format ?? 'tree').toLowerCase();

  // A file is the natural destination for a whole page; stdout is for the text
  // formats you pipe somewhere.
  const emit = async (body: string, defaultName: string) => {
    const target = options.out ?? (format === 'html' ? defaultName : undefined);
    if (!target) {
      out(body);
      return;
    }
    const file = path.resolve(root, target);
    await fs.writeFile(file, body, 'utf8');
    success(`Wrote ${bold(path.relative(root, file) || file)}`);
    if (format === 'html') note(dim('  Open it in a browser — it needs no server and no network.'));
  };

  // The tree views are coloured for a terminal, which the destination file is not.
  const plain = (body: string) => (options.out ? body.replace(/\u001B\[\d+m/g, '') : body);

  let drawn = memory;
  if (options.focus) {
    const node = focusNode(memory, options.focus);
    if (!node) {
      warn(`Nothing in the memory matches "${options.focus}".`);
      process.exitCode = 1;
      return;
    }
    if (format === 'html') {
      // The page defaults to the file `ui --once` writes, so one neighbourhood
      // rendered there would quietly replace the whole project's map.
      fail('--focus cannot be drawn as a page. Use tree, json, mermaid or dot, or drop --focus.');
      process.exitCode = 1;
      return;
    }
    if (format === 'tree') {
      await emit(plain(renderFocus(memory, node)), 'focus.txt');
      return;
    }
    drawn = focused(memory, node.id);
  }

  switch (format) {
    case 'mermaid':
      await emit(renderMermaid(drawn), 'graph.mmd');
      return;
    case 'dot':
      await emit(renderDot(drawn), 'graph.dot');
      return;
    case 'json':
      await emit(JSON.stringify({ nodes: drawn.nodes, edges: drawn.edges }, null, 2), 'graph.json');
      return;
    case 'html':
      await emit(renderGraphHtml(drawn, signals(drawn)), HTML_FILE);
      return;
    default:
      await emit(plain(renderTree(drawn)), 'graph.txt');
  }
}

function focusNode(memory: ProjectMemory, focus: string): MemoryNode | undefined {
  return memory.nodes.find((n) => n.id === focus) ?? search(memory, focus, 1)[0]?.node;
}

/**
 * The focus as data rather than as prose: the node, everything one edge away,
 * and only the edges with both ends in that set — a consumer of the JSON must
 * never be handed an edge pointing at a node the file does not contain.
 */
function focused(memory: ProjectMemory, id: string): ProjectMemory {
  const hood = neighbourhood(memory, id)!;
  const nodes = new Map(
    [hood.node, ...hood.outgoing.map((o) => o.node), ...hood.incoming.map((i) => i.node)].map(
      (n) => [n.id, n] as const,
    ),
  );
  return {
    ...memory,
    nodes: [...nodes.values()],
    edges: memory.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
  };
}

function renderTree(memory: ProjectMemory): string {
  const arch = architecture(memory);
  const lines = ['', bold(cyan(memory.project.name)), ''];

  for (const contract of arch.contracts) {
    const deployments = contract.deployments
      .map((d) => {
        const data = d.data as unknown as DeploymentData | undefined;
        const state = driftState(data?.drift);
        // The unchecked state is deliberately uncoloured: green here read as a
        // verified match for every deployment whose hash was never fetched.
        const mark =
          state === 'stale'
            ? yellow(DRIFT_LABEL.stale)
            : state === 'in-sync'
              ? green(DRIFT_LABEL['in-sync'])
              : DRIFT_LABEL.unknown;
        return `${data?.network} ${dim(`(${mark})`)}`;
      })
      .join(', ');

    lines.push(`${cyan('◆')} ${bold(contract.node.title)}${contract.crate ? dim(`  ${contract.crate}`) : ''}`);
    if (deployments) lines.push(`  ${dim('on-chain')}  ${deployments}`);

    for (const call of contract.calls) {
      lines.push(`  ${dim('calls')}     ${call.title}`);
    }
    for (const fn of contract.functions.slice(0, 12)) {
      lines.push(`  ${dim('fn')}        ${fn.title}`);
    }
    if (contract.functions.length > 12) {
      lines.push(dim(`            …and ${contract.functions.length - 12} more`));
    }
    if (contract.tests.length > 0) {
      lines.push(`  ${dim('tested by')} ${contract.tests.map((t) => t.title).join(', ')}`);
    }
    lines.push('');
  }

  if (nodesOfKind(memory, 'contract').length === 0) lines.push(dim('  No contracts found.'));
  return lines.join('\n');
}

function renderFocus(memory: ProjectMemory, node: MemoryNode): string {
  const hood = neighbourhood(memory, node.id)!;
  const lines = ['', bold(cyan(`${node.title} ${dim(`(${node.kind})`)}`))];
  if (node.summary) lines.push(node.summary);
  if (node.path) lines.push(dim(`${node.path}${node.line ? `:${node.line}` : ''}`));
  lines.push('');

  if (hood.outgoing.length > 0) {
    lines.push(bold('Points to'));
    for (const { edge, node: target } of hood.outgoing) {
      lines.push(`  ${dim(edge.kind.padEnd(12))} ${target.title} ${dim(`(${target.kind})`)}`);
    }
    lines.push('');
  }
  if (hood.incoming.length > 0) {
    lines.push(bold('Pointed to by'));
    for (const { edge, node: source } of hood.incoming) {
      lines.push(`  ${dim(edge.kind.padEnd(12))} ${source.title} ${dim(`(${source.kind})`)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Mermaid, so the map can be pasted straight into a README or an issue. */
function renderMermaid(memory: ProjectMemory): string {
  const arch = architecture(memory);
  const lines = ['graph TD'];
  const seen = new Set<string>();

  for (const contract of arch.contracts) {
    const id = safeId(contract.node.id);
    if (!seen.has(id)) {
      lines.push(`  ${id}["${escapeLabel(contract.node.title)}"]`);
      seen.add(id);
    }
    for (const deployment of contract.deployments) {
      const data = deployment.data as unknown as DeploymentData | undefined;
      const did = safeId(deployment.id);
      if (!seen.has(did)) {
        lines.push(`  ${did}(["${escapeLabel(String(data?.network))}: ${shortId(String(data?.contractId))}"])`);
        seen.add(did);
      }
      lines.push(`  ${id} -.->|deployed| ${did}`);
    }
  }

  for (const edge of memory.edges) {
    if (edge.kind !== 'calls') continue;
    lines.push(`  ${safeId(edge.from)} -->|calls| ${safeId(edge.to)}`);
  }

  if (lines.length === 1) lines.push('  empty["No contracts detected"]');
  return lines.join('\n');
}

/** Graphviz, for anyone who wants an image out of it. */
function renderDot(memory: ProjectMemory): string {
  const lines = ['digraph stellar_memory {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  const arch = architecture(memory);
  for (const contract of arch.contracts) {
    lines.push(`  "${escapeLabel(contract.node.title)}";`);
  }
  for (const edge of memory.edges) {
    if (edge.kind !== 'calls') continue;
    const from = memory.nodes.find((n) => n.id === edge.from)?.title ?? edge.from;
    const to = memory.nodes.find((n) => n.id === edge.to)?.title ?? edge.to;
    lines.push(`  "${escapeLabel(from)}" -> "${escapeLabel(to)}" [label="calls"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '_');
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, '\\"');
}

function shortId(contractId: string): string {
  return contractId.length > 12 ? `${contractId.slice(0, 6)}…${contractId.slice(-4)}` : contractId;
}
