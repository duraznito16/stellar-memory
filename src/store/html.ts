/**
 * A single self-contained HTML page showing the project as a graph.
 *
 * No server, no build step, no network: one file you open with a double click.
 * That constraint is the point — a developer can commit it, attach it to a pull
 * request, or open it on a plane, and it still works.
 *
 * The layout is computed here rather than in the browser, so the output is
 * deterministic: the same memory produces byte-identical HTML, which keeps it
 * diffable in git alongside the vault it describes.
 */

import type { MemoryEdge, MemoryNode, NodeKind, ProjectMemory } from '../core/types.js';
import type { Signal } from '../core/query.js';

/* ------------------------------------------------------------------ *
 * Colour
 *
 * A node-link graph places every kind beside every other, so the palette is
 * held to the all-pairs bar rather than the adjacent-pairs one. Only three
 * categorical hues clear it, so three is what this uses; every other kind folds
 * into muted ink rather than inventing a fourth hue. Size and shape carry the
 * rest, and status is a reserved palette that never doubles as a category.
 *
 * Validated with the palette checker in both modes, all pairs. Dark passes
 * outright. Light passes with one contrast warning — the storage aqua sits at
 * 2.74:1 on the light surface — which obliges relief: storage nodes are drawn
 * as squares rather than circles, and every element is also listed in a table
 * below the figure. Neither the legend nor the findings rely on hue alone.
 * ------------------------------------------------------------------ */

interface Group {
  id: string;
  label: string;
  kinds: NodeKind[];
  radius: number;
  shape: 'circle' | 'square' | 'diamond';
}

const GROUPS: Group[] = [
  { id: 'contract', label: 'Contract', kinds: ['contract'], radius: 15, shape: 'circle' },
  {
    id: 'onchain',
    label: 'On-chain',
    kinds: ['deployment', 'asset'],
    radius: 11,
    shape: 'diamond',
  },
  { id: 'storage', label: 'Storage key', kinds: ['storage'], radius: 8, shape: 'square' },
  {
    id: 'other',
    label: 'Function, event, error, test',
    kinds: ['function', 'event', 'error', 'test'],
    radius: 6,
    shape: 'circle',
  },
];

const KIND_GROUP = new Map<NodeKind, Group>();
for (const group of GROUPS) for (const kind of group.kinds) KIND_GROUP.set(kind, group);

/** Kinds that would crowd the picture without explaining the system. */
const EXCLUDED: NodeKind[] = ['project', 'crate', 'module', 'doc', 'script', 'task', 'type', 'decision'];

/* ------------------------------------------------------------------ *
 * Layout — a small spring-electrical simulation, run to convergence here.
 * ------------------------------------------------------------------ */

interface Placed {
  node: MemoryNode;
  group: Group;
  x: number;
  y: number;
  severity?: Signal['severity'];
  categories: string[];
}

const WIDTH = 1100;
const HEIGHT = 720;

/** Deterministic PRNG, so the same memory always draws the same picture. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function layout(nodes: Placed[], edges: MemoryEdge[]): void {
  const index = new Map(nodes.map((p, i) => [p.node.id, i]));
  const links = edges
    .map((e) => ({ a: index.get(e.from), b: index.get(e.to) }))
    .filter((l): l is { a: number; b: number } => l.a !== undefined && l.b !== undefined);

  const rand = seeded(0x5713);
  // Start on a circle rather than at random: a ring untangles far more reliably
  // than a cloud, and keeps the first frames from folding over themselves.
  nodes.forEach((p, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const jitter = 0.85 + rand() * 0.3;
    p.x = WIDTH / 2 + Math.cos(angle) * 260 * jitter;
    p.y = HEIGHT / 2 + Math.sin(angle) * 220 * jitter;
  });

  const iterations = 420;
  const area = WIDTH * HEIGHT;
  const k = Math.sqrt(area / Math.max(nodes.length, 1)) * 0.62;

  for (let step = 0; step < iterations; step++) {
    // Cooling: large moves early to escape tangles, small ones late to settle.
    const temperature = (1 - step / iterations) ** 1.5 * (WIDTH / 12);
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let ax = nodes[i]!.x - nodes[j]!.x;
        let ay = nodes[i]!.y - nodes[j]!.y;
        let dist = Math.hypot(ax, ay);
        if (dist < 0.01) {
          ax = (rand() - 0.5) * 0.1;
          ay = (rand() - 0.5) * 0.1;
          dist = 0.01;
        }
        const force = (k * k) / dist;
        const fx = (ax / dist) * force;
        const fy = (ay / dist) * force;
        dx[i]! += fx; dy[i]! += fy;
        dx[j]! -= fx; dy[j]! -= fy;
      }
    }

    for (const link of links) {
      const ax = nodes[link.a]!.x - nodes[link.b]!.x;
      const ay = nodes[link.a]!.y - nodes[link.b]!.y;
      const dist = Math.max(Math.hypot(ax, ay), 0.01);
      const force = (dist * dist) / k;
      const fx = (ax / dist) * force;
      const fy = (ay / dist) * force;
      dx[link.a]! -= fx; dy[link.a]! -= fy;
      dx[link.b]! += fx; dy[link.b]! += fy;
    }

    for (let i = 0; i < nodes.length; i++) {
      const dist = Math.max(Math.hypot(dx[i]!, dy[i]!), 0.01);
      const move = Math.min(dist, temperature);
      const p = nodes[i]!;
      p.x += (dx[i]! / dist) * move;
      p.y += (dy[i]! / dist) * move;
      // Labelled nodes need room for the text, not just the mark. Without the
      // wider horizontal margin a deployment near the edge has its name clipped
      // by the canvas — the label is centred on the node, so half of it hangs
      // outside.
      const labelled = p.group.id === 'contract' || p.group.id === 'onchain';
      const padX = labelled ? Math.max(p.group.radius + 14, 82) : p.group.radius + 14;
      const padY = p.group.radius + (labelled ? 26 : 14);
      p.x = Math.min(WIDTH - padX, Math.max(padX, p.x));
      p.y = Math.min(HEIGHT - padY, Math.max(padY, p.y));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n2 = (value: number): string => Math.round(value * 100) / 100 + '';

export function renderGraphHtml(memory: ProjectMemory, signals: Signal[]): string {
  const worst = new Map<string, Signal>();
  const byNode = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (!signal.nodeId) continue;
    const list = byNode.get(signal.nodeId) ?? [];
    list.push(signal);
    byNode.set(signal.nodeId, list);
    const current = worst.get(signal.nodeId);
    if (!current || (current.severity === 'info' && signal.severity === 'warn')) {
      worst.set(signal.nodeId, signal);
    }
  }

  const placed: Placed[] = memory.nodes
    .filter((node) => !EXCLUDED.includes(node.kind))
    .map((node) => {
      const found = byNode.get(node.id) ?? [];
      return {
        node,
        group: KIND_GROUP.get(node.kind) ?? GROUPS[3]!,
        x: 0,
        y: 0,
        severity: worst.get(node.id)?.severity,
        categories: [...new Set(found.map((s) => s.category))],
      };
    });

  const visible = new Set(placed.map((p) => p.node.id));
  const edges = memory.edges.filter((e) => visible.has(e.from) && visible.has(e.to));

  layout(placed, edges);

  const positions = new Map(placed.map((p) => [p.node.id, p]));
  const warnCount = signals.filter((s) => s.severity === 'warn').length;

  const edgeSvg = edges
    .map((edge) => {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      return `<line class="edge edge--${edge.kind}" x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(b.x)}" y2="${n2(b.y)}"><title>${esc(a.node.title)} ${esc(edge.kind)} ${esc(b.node.title)}</title></line>`;
    })
    .join('\n');

  const nodeSvg = placed
    .map((p) => {
      const r = p.group.radius;
      const shape =
        p.group.shape === 'square'
          ? `<rect x="${n2(p.x - r)}" y="${n2(p.y - r)}" width="${n2(r * 2)}" height="${n2(r * 2)}" rx="2" />`
          : p.group.shape === 'diamond'
            ? `<path d="M ${n2(p.x)} ${n2(p.y - r * 1.25)} L ${n2(p.x + r * 1.25)} ${n2(p.y)} L ${n2(p.x)} ${n2(p.y + r * 1.25)} L ${n2(p.x - r * 1.25)} ${n2(p.y)} Z" />`
            : `<circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(r)}" />`;

      // A finding needs a mark that survives a small node on a light surface and
      // a greyscale print. The status yellow alone does not — it sits below 3:1
      // on light by design — so the ring is thick and dashed, and a glyph sits
      // beside it. Shape and symbol carry the meaning; colour only reinforces it.
      const ring =
        p.severity === 'warn'
          ? `<circle class="ring ring--warn" cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(r + 5)}" />` +
            `<text class="flag" x="${n2(p.x + r + 5)}" y="${n2(p.y - r - 3)}">!</text>`
          : '';

      // Contracts and on-chain nodes are few and are the ones a reader is
      // looking for by name. Functions and storage keys are not labelled: at
      // this density the labels would collide and hide the structure.
      const label =
        p.group.id === 'contract' || p.group.id === 'onchain'
          ? `<text class="node-label node-label--${p.group.id}" x="${n2(p.x)}" y="${n2(p.y + r + 15)}">${esc(p.node.title)}</text>`
          : '';

      return `<g class="node node--${p.group.id}" tabindex="0" role="listitem" data-id="${esc(p.node.id)}" aria-label="${esc(p.node.title)}, ${esc(p.node.kind)}">${ring}${shape}${label}<title>${esc(p.node.title)} (${esc(p.node.kind)})</title></g>`;
    })
    .join('\n');

  const detail = placed.map((p) => {
    const findings = (byNode.get(p.node.id) ?? []).map((s) => ({
      severity: s.severity,
      category: s.category,
      message: s.message,
    }));
    return [
      p.node.id,
      {
        title: p.node.title,
        kind: p.node.kind,
        path: p.node.path ?? null,
        line: p.node.line ?? null,
        summary: p.node.summary ?? null,
        findings,
        links: memory.edges
          .filter((e) => e.from === p.node.id || e.to === p.node.id)
          .slice(0, 24)
          .map((e) => ({
            kind: e.kind,
            other: (e.from === p.node.id ? memory.nodes.find((n) => n.id === e.to) : memory.nodes.find((n) => n.id === e.from))?.title ?? '',
            direction: e.from === p.node.id ? 'out' : 'in',
          })),
      },
    ];
  });

  const rows = placed
    .slice()
    .sort((a, b) => a.node.kind.localeCompare(b.node.kind) || a.node.title.localeCompare(b.node.title))
    .map(
      (p) =>
        `<tr><td>${esc(p.node.title)}</td><td>${esc(p.node.kind)}</td><td>${esc(p.node.path ?? '')}</td><td>${p.severity === 'warn' ? '⚠ needs attention' : ''}</td></tr>`,
    )
    .join('\n');

  return PAGE({
    project: esc(memory.project.name),
    purpose: memory.project.purpose ? esc(memory.project.purpose) : '',
    contracts: memory.nodes.filter((n) => n.kind === 'contract').length,
    nodes: placed.length,
    edges: edges.length,
    warnings: warnCount,
    edgeSvg,
    nodeSvg,
    rows,
    detail: JSON.stringify(Object.fromEntries(detail)),
    generated: memory.scans[memory.scans.length - 1]?.at ?? '',
  });
}

interface PageData {
  project: string;
  purpose: string;
  contracts: number;
  nodes: number;
  edges: number;
  warnings: number;
  edgeSvg: string;
  nodeSvg: string;
  rows: string;
  detail: string;
  generated: string;
}

const PAGE = (d: PageData): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${d.project} — project memory</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --hairline: #e1e0d9;
    --border: rgba(11,11,11,0.10);
    --contract: #2a78d6;
    --onchain: #eb6834;
    --storage: #1baf7a;
    --other: #898781;
    --status-warning: #fab219;
    --status-critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --plane: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --hairline: #2c2c2a;
      --border: rgba(255,255,255,0.10);
      --contract: #3987e5;
      --onchain: #d95926;
      --storage: #199e70;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --plane: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --hairline: #2c2c2a;
    --border: rgba(255,255,255,0.10);
    --contract: #3987e5;
    --onchain: #d95926;
    --storage: #199e70;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--plane);
    color: var(--text-primary);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 32px 20px 64px; }
  header { margin-bottom: 22px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .purpose { color: var(--text-secondary); margin: 0 0 16px; max-width: 70ch; }
  .stats { display: flex; flex-wrap: wrap; gap: 26px; margin-bottom: 4px; }
  .stat b { display: block; font-size: 22px; line-height: 1.2; }
  .stat span { color: var(--muted); font-size: 13px; }
  .stat--warn b { color: var(--status-critical); }

  .legend { display: flex; flex-wrap: wrap; gap: 18px; margin: 18px 0 10px; font-size: 13px; color: var(--text-secondary); }
  .legend-item { display: flex; align-items: center; gap: 7px; }
  .swatch { width: 12px; height: 12px; border-radius: 50%; flex: none; }
  .swatch--square { border-radius: 2px; }
  .swatch--diamond { border-radius: 2px; transform: rotate(45deg); }
  .swatch--ring { background: none; border: 2px dashed var(--status-critical); }

  .board { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 18px; align-items: start; }
  @media (max-width: 940px) { .board { grid-template-columns: 1fr; } }

  .canvas {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow-x: auto;
  }
  svg { display: block; width: 100%; height: auto; }

  .edge { stroke: var(--hairline); stroke-width: 1.25; }
  .edge--calls { stroke: var(--contract); stroke-width: 2; stroke-opacity: 0.55; }
  .edge--deployed_as { stroke: var(--onchain); stroke-width: 2; stroke-dasharray: 4 3; }
  .edge--writes { stroke: var(--storage); stroke-width: 1.75; }

  .node { cursor: pointer; }
  .node > rect, .node > circle, .node > path { stroke: var(--surface-1); stroke-width: 2; }
  .node--contract > circle { fill: var(--contract); }
  .node--onchain > path { fill: var(--onchain); }
  .node--storage > rect { fill: var(--storage); }
  .node--other > circle { fill: var(--other); }
  .node:hover > rect, .node:hover > circle, .node:hover > path,
  .node:focus > rect, .node:focus > circle, .node:focus > path { stroke: var(--text-primary); }
  .node:focus { outline: none; }
  .node.is-selected > rect, .node.is-selected > circle, .node.is-selected > path { stroke: var(--text-primary); stroke-width: 3; }

  .ring { fill: none; stroke-width: 3; stroke-dasharray: 3 2.5; }
  .ring--warn { stroke: var(--status-critical); }

  .flag {
    font: 700 13px system-ui, sans-serif;
    fill: var(--status-critical);
    paint-order: stroke;
    stroke: var(--surface-1);
    stroke-width: 3;
    pointer-events: none;
  }

  .node-label {
    font: 600 12px system-ui, sans-serif;
    fill: var(--text-primary);
    text-anchor: middle;
    paint-order: stroke;
    stroke: var(--surface-1);
    stroke-width: 3.5;
    pointer-events: none;
  }
  .node-label--onchain { font-weight: 500; font-size: 11px; fill: var(--text-secondary); }

  .panel {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    position: sticky;
    top: 18px;
  }
  .panel h2 { font-size: 15px; margin: 0 0 2px; }
  .panel .kind { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .panel .path { font: 12px ui-monospace, Menlo, Consolas, monospace; color: var(--text-secondary); word-break: break-all; margin: 8px 0; }
  .panel p { color: var(--text-secondary); font-size: 13px; }
  .finding { border-left: 3px solid var(--status-warning); padding: 6px 0 6px 10px; margin: 10px 0; font-size: 13px; }
  .finding .tag { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin-right: 6px; }
  .rel { font-size: 13px; display: flex; gap: 8px; padding: 2px 0; }
  .rel code { font: 11px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); min-width: 84px; }

  details { margin-top: 24px; }
  summary { cursor: pointer; color: var(--text-secondary); font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--hairline); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${d.project}</h1>
    ${d.purpose ? `<p class="purpose">${d.purpose}</p>` : ''}
    <div class="stats">
      <div class="stat"><b>${d.contracts}</b><span>contracts</span></div>
      <div class="stat"><b>${d.nodes}</b><span>elements</span></div>
      <div class="stat"><b>${d.edges}</b><span>relationships</span></div>
      <div class="stat stat--warn"><b>${d.warnings}</b><span>need attention</span></div>
    </div>
  </header>

  <div class="legend" role="list">
    <span class="legend-item" role="listitem"><span class="swatch" style="background: var(--contract)"></span> Contract</span>
    <span class="legend-item" role="listitem"><span class="swatch swatch--diamond" style="background: var(--onchain)"></span> On-chain</span>
    <span class="legend-item" role="listitem"><span class="swatch swatch--square" style="background: var(--storage)"></span> Storage key</span>
    <span class="legend-item" role="listitem"><span class="swatch" style="background: var(--other)"></span> Function, event, error, test</span>
    <span class="legend-item" role="listitem"><span class="swatch swatch--ring"></span> ⚠ Has a finding</span>
  </div>

  <div class="board">
    <div class="canvas">
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="list" aria-label="Project graph">
        <g class="edges">${d.edgeSvg}</g>
        <g class="nodes">${d.nodeSvg}</g>
      </svg>
    </div>
    <aside class="panel" id="panel">
      <h2>Select an element</h2>
      <p>Click any node to see what it is, where it lives, and what it connects to. Everything here came from the source and from read-only queries to the network.</p>
    </aside>
  </div>

  <details>
    <summary>Every element as a table</summary>
    <table>
      <thead><tr><th>Name</th><th>Kind</th><th>Source</th><th>Status</th></tr></thead>
      <tbody>${d.rows}</tbody>
    </table>
  </details>

  <footer>Generated by stellar-memory${d.generated ? ` from the scan of ${esc(d.generated)}` : ''}. This file is self-contained: no network, no server.</footer>
</div>

<script>
const DETAIL = ${d.detail};
const panel = document.getElementById('panel');
let selected = null;

function show(id) {
  const d = DETAIL[id];
  if (!d) return;
  if (selected) selected.classList.remove('is-selected');
  selected = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (selected) selected.classList.add('is-selected');

  const findings = d.findings.map(f =>
    '<div class="finding"><span class="tag">' + f.category + '</span>' + escapeHtml(f.message) + '</div>'
  ).join('');
  const links = d.links.map(l =>
    '<div class="rel"><code>' + (l.direction === 'out' ? '→ ' : '← ') + l.kind + '</code><span>' + escapeHtml(l.other) + '</span></div>'
  ).join('');

  panel.innerHTML =
    '<div class="kind">' + d.kind + '</div>' +
    '<h2>' + escapeHtml(d.title) + '</h2>' +
    (d.summary ? '<p>' + escapeHtml(d.summary) + '</p>' : '') +
    (d.path ? '<div class="path">' + escapeHtml(d.path) + (d.line ? ':' + d.line : '') + '</div>' : '') +
    findings +
    (links ? '<h2 style="margin-top:16px">Connections</h2>' + links : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

for (const node of document.querySelectorAll('.node')) {
  node.addEventListener('click', () => show(node.dataset.id));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(node.dataset.id); }
  });
}
</script>
</body>
</html>
`;
