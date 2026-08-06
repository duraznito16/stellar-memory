import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tryLoadMemory } from '../store/vault.js';
import { architecture, neighbourhood, nodesOfKind, search, signals } from '../core/query.js';
import { renderGraphHtml } from '../store/html.js';
import type { DeploymentData, MemoryNode, ProjectMemory } from '../core/types.js';
import { out, note, success, warn, dim, bold, cyan, green, yellow, heading } from '../ui/out.js';

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

  if (options.focus) {
    renderFocus(memory, options.focus);
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
    note(dim('  Open it in a browser — it needs no server and no network.'));
  };

  switch (format) {
    case 'mermaid':
      await emit(renderMermaid(memory), 'graph.mmd');
      return;
    case 'dot':
      await emit(renderDot(memory), 'graph.dot');
      return;
    case 'json':
      await emit(JSON.stringify({ nodes: memory.nodes, edges: memory.edges }, null, 2), 'graph.json');
      return;
    case 'html':
      await emit(renderGraphHtml(memory, signals(memory)), 'stellar-memory-graph.html');
      return;
    default:
      renderTree(memory);
  }
}

function renderTree(memory: ProjectMemory): void {
  const arch = architecture(memory);

  out();
  heading(memory.project.name);
  out();

  for (const contract of arch.contracts) {
    const deployments = contract.deployments
      .map((d) => {
        const data = d.data as unknown as DeploymentData | undefined;
        const mark = data?.drift === 'stale' ? yellow('stale') : green('in sync');
        return `${data?.network} ${dim(`(${mark})`)}`;
      })
      .join(', ');

    out(`${cyan('◆')} ${bold(contract.node.title)}${contract.crate ? dim(`  ${contract.crate}`) : ''}`);
    if (deployments) out(`  ${dim('on-chain')}  ${deployments}`);

    for (const call of contract.calls) {
      out(`  ${dim('calls')}     ${call.title}`);
    }
    for (const fn of contract.functions.slice(0, 12)) {
      out(`  ${dim('fn')}        ${fn.title}`);
    }
    if (contract.functions.length > 12) {
      out(dim(`            …and ${contract.functions.length - 12} more`));
    }
    if (contract.tests.length > 0) {
      out(`  ${dim('tested by')} ${contract.tests.map((t) => t.title).join(', ')}`);
    }
    out();
  }

  const orphans = nodesOfKind(memory, 'contract').length === 0;
  if (orphans) out(dim('  No contracts found.'));
}

function renderFocus(memory: ProjectMemory, focus: string): void {
  let node: MemoryNode | undefined = memory.nodes.find((n) => n.id === focus);
  if (!node) {
    const hit = search(memory, focus, 1)[0];
    node = hit?.node;
  }
  if (!node) {
    warn(`Nothing in the memory matches "${focus}".`);
    process.exitCode = 1;
    return;
  }

  const hood = neighbourhood(memory, node.id)!;
  out();
  heading(`${node.title} ${dim(`(${node.kind})`)}`);
  if (node.summary) out(node.summary);
  if (node.path) out(dim(`${node.path}${node.line ? `:${node.line}` : ''}`));
  out();

  if (hood.outgoing.length > 0) {
    out(bold('Points to'));
    for (const { edge, node: target } of hood.outgoing) {
      out(`  ${dim(edge.kind.padEnd(12))} ${target.title} ${dim(`(${target.kind})`)}`);
    }
    out();
  }
  if (hood.incoming.length > 0) {
    out(bold('Pointed to by'));
    for (const { edge, node: source } of hood.incoming) {
      out(`  ${dim(edge.kind.padEnd(12))} ${source.title} ${dim(`(${source.kind})`)}`);
    }
    out();
  }
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
