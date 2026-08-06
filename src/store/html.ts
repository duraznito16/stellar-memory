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
 *
 * `stellar-memory ui` serves the same page from a local server and needs a
 * little more from it — a reload client, and a layout that fills a window
 * rather than a printed page. Those arrive through `RenderOptions.live`, which
 * is absent by default: the committed artifact cannot acquire a reference to a
 * server by accident, because producing one takes an argument nobody passes.
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

/**
 * How many nodes the layout will place.
 *
 * Repulsion is all-pairs and runs on every one of the 420 iterations, so the
 * cost is n²·210. Measured here: the demo's 36 nodes take 8ms, 300 take 0.4s,
 * and the 2140 a twenty-contract workspace produces take 18 seconds — 18
 * seconds with `renderGraphHtml` on the stack, so `ui` dispatches no `scanned`
 * frame, the pill stays on "scanning…" and a window can give up and reconnect.
 * A drawing that size is an unreadable mat of ink anyway, which is why this
 * trims the picture rather than approximating the physics: an approximation
 * would move every node in every existing graph, and the file is committed.
 */
const DRAWN_LIMIT = 300;

/**
 * The nodes worth the budget.
 *
 * Findings first, because a warning the header counts and the picture cannot
 * show is the failure this tool exists to prevent. Then the structural kinds —
 * a contract, where it is deployed, what it stores — which are what a reader is
 * looking for at this scale; functions, events, errors and tests are most of a
 * large workspace and the least of it at a glance. The sort is stable and the
 * filter keeps memory order, so the choice is as deterministic as the layout.
 */
function withinBudget(placed: Placed[]): Placed[] {
  if (placed.length <= DRAWN_LIMIT) return placed;
  return placed
    .filter((p) => p.severity !== undefined || p.group.id !== 'other')
    .sort((a, b) => Number(a.severity === undefined) - Number(b.severity === undefined))
    .slice(0, DRAWN_LIMIT);
}

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

/**
 * JSON on its way into a `<script>` element.
 *
 * The HTML parser ends that element at the first `</script` in its raw text —
 * including one sitting inside a JSON string — and everything after it is parsed
 * as markup. That is not hypothetical input: `.stellar-memory/index.json` is a
 * committed, cloned artifact, loaded with a cast and no runtime validation, so
 * every string in it arrives from whoever wrote the repo rather than from here.
 * U+2028 and U+2029 are escaped because JSON permits them raw inside a string
 * and JavaScript, before ES2019, did not.
 */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

/**
 * One policy, carried two ways.
 *
 * The page has no external stylesheet, script, font or image, so saying so costs
 * nothing and means a contract name that somehow smuggled markup past the
 * escaping still cannot phone anywhere. `ui` sends it as a response header,
 * which is the stronger copy; the written file has only its own `<meta>`, and
 * the written file is the one people commit and open over `file://`.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const n2 = (value: number): string => Math.round(value * 100) / 100 + '';

/**
 * Code units, never `localeCompare`.
 *
 * Called with no locale it takes the runtime's, which comes from ICU and from
 * `LANG`/`LC_ALL`, so `Ödeme` sorts before `Zebra` on one machine and after it
 * on the next. This file is otherwise deterministic to the byte — seeded PRNG,
 * rounded coordinates, memory order everywhere else — and a table that reorders
 * itself between a laptop and CI is a diff nobody made.
 */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface LiveOptions {
  /**
   * Changes exactly when the drawing changes, so the page can tell whether the
   * server is showing something it is not. Deriving it from the content rather
   * than from a counter also means a window that reconnects to a *restarted*
   * server reloads only if the project really moved meanwhile.
   */
  stamp: string;
}

export interface RenderOptions {
  /**
   * Present only for the page `stellar-memory ui` serves: it fills the window,
   * lists the findings, and reconnects to the event stream at `/events`.
   *
   * Absent is the default, and absent means none of that is in the output. The
   * file `graph --format html` writes gets committed and attached to pull
   * requests, so it must never carry a reference to a server that will not be
   * there — and the only way to produce one is to pass this.
   */
  live?: LiveOptions;
}

export function renderGraphHtml(
  memory: ProjectMemory,
  signals: Signal[],
  options: RenderOptions = {},
): string {
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

  // The table below the figure lists `placed`, so trimming the drawing never
  // takes an element off the page altogether.
  const drawn = withinBudget(placed);
  const visible = new Set(drawn.map((p) => p.node.id));
  const edges = memory.edges.filter((e) => visible.has(e.from) && visible.has(e.to));

  layout(drawn, edges);

  const positions = new Map(drawn.map((p) => [p.node.id, p]));
  const warnCount = signals.filter((s) => s.severity === 'warn').length;

  // The endpoints travel with the line so the page can light up one node's
  // neighbourhood without shipping the edge list twice.
  const edgeSvg = edges
    .map((edge) => {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      // `edge.kind` is a union in the types and a string on disk, so it is
      // escaped here like every other value from the vault — including in the
      // class name, where an unescaped quote would end the attribute.
      return `<line class="edge edge--${esc(edge.kind)}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(b.x)}" y2="${n2(b.y)}"><title>${esc(a.node.title)} ${esc(edge.kind)} ${esc(b.node.title)}</title></line>`;
    })
    .join('\n');

  const nodeSvg = drawn
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
      // looking for by name, so they are labelled outright. Every other node
      // carries its name too, hidden, and only the handful next to a selected
      // node ever shows: at this density all of them at once would collide and
      // hide the structure that is the point of the picture.
      //
      // A revealed storage key is far wider than the mark the layout reserved
      // room for, so near the edges of the canvas the label grows inward rather
      // than off the side.
      const labelled = p.group.id === 'contract' || p.group.id === 'onchain';
      const anchor = p.x < 160 ? 'start' : p.x > WIDTH - 160 ? 'end' : 'middle';
      const label = labelled
        ? `<text class="node-label node-label--${p.group.id}" x="${n2(p.x)}" y="${n2(p.y + r + 15)}">${esc(p.node.title)}</text>`
        : `<text class="node-label node-label--near" text-anchor="${anchor}" x="${n2(p.x)}" y="${n2(p.y + r + 14)}">${esc(p.node.title)}</text>`;

      return `<g class="node node--${p.group.id}" tabindex="0" role="listitem" data-id="${esc(p.node.id)}" aria-label="${esc(p.node.title)}, ${esc(p.node.kind)}">${ring}${shape}${label}<title>${esc(p.node.title)} (${esc(p.node.kind)})</title></g>`;
    })
    .join('\n');

  const detail = drawn.map((p) => {
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
    .sort((a, b) => order(a.node.kind, b.node.kind) || order(a.node.title, b.node.title))
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
    // A trimmed graph that does not say so is worse than a complete one that
    // was slow to draw: the reader counts three storage keys and believes there
    // are three. Numbers only, so there is nothing here to escape.
    trimmed:
      drawn.length < placed.length
        ? `<p class="trimmed">Drawing ${drawn.length} of ${placed.length} elements. Contracts, on-chain entries, storage keys and anything with a finding come first; the rest are left out to keep the picture legible and the page quick to produce.</p>`
        : '',
    edgeSvg,
    nodeSvg,
    rows,
    detail: jsonForScript(Object.fromEntries(detail)),
    generated: memory.scans[memory.scans.length - 1]?.at ?? '',
    live: options.live !== undefined,
    stamp: options.live?.stamp ?? '',
    findings: options.live ? findingList(memory, signals) : '',
    // What the heading counts is what the list beneath it contains, warnings
    // and observations alike. `warnings` above answers a different question —
    // how many of them need attention — and the header stat is where it is
    // asked. Two numbers, each true of the set it names.
    findingCount: options.live ? signals.length : 0,
    // A finding about the project belongs to no node, so the file page — which
    // has no findings list — would count it in the header and then show it
    // nowhere. A number the page cannot substantiate is the failure this tool
    // exists to prevent, so it gets its own block instead.
    projectFindings: options.live ? '' : projectFindingBlock(signals),
  });
}

function projectFindingBlock(signals: Signal[]): string {
  const wide = signals.filter((s) => s.scope === 'project');
  if (wide.length === 0) return '';
  return (
    `<section class="project-findings"><h2>About the project</h2>` +
    wide
      .map(
        (s) =>
          `<div class="finding finding--${s.severity}"><span class="tag">${esc(s.category)}</span>${esc(s.message)}</div>`,
      )
      .join('') +
    `</section>`
  );
}

/**
 * The findings, on screen before anything is clicked.
 *
 * Served rather than committed, because it is the served page that has to be
 * read at a distance: on the graph a finding is a dashed ring and a `!`, and
 * five of the six in the demo sit on nodes too small to carry a name. The
 * committed file has the table underneath it instead, which a reader can scroll.
 */
function findingList(memory: ProjectMemory, signals: Signal[]): string {
  const byId = new Map(memory.nodes.map((n) => [n.id, n]));

  return signals
    .slice()
    // Stable sort, so within a severity the order is still the order signals()
    // reported — grouped by the check that produced them.
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1))
    .map((signal) => {
      // A project-level observation has no single owner. Giving it one lets a
      // presenter click a contract and read out a claim about three of them.
      const owner = signal.scope === 'project' ? undefined : signal.nodeId ? byId.get(signal.nodeId) : undefined;
      const where = owner?.path
        ? `${owner.path}${owner.line ? `:${owner.line}` : ''}`
        : signal.scope === 'project'
          ? 'project-wide'
          : '';
      return (
        `<button type="button" class="finding finding--${signal.severity}"${owner ? ` data-id="${esc(owner.id)}"` : ''}>` +
        `<span class="tag">${esc(signal.category)}</span>` +
        `<span class="msg">${esc(signal.message)}</span>` +
        (where ? `<span class="where">${esc(where)}</span>` : '') +
        `</button>`
      );
    })
    .join('\n');
}

interface PageData {
  project: string;
  purpose: string;
  contracts: number;
  nodes: number;
  edges: number;
  warnings: number;
  /** Present only when the graph was too large to draw in full. */
  trimmed: string;
  edgeSvg: string;
  nodeSvg: string;
  rows: string;
  detail: string;
  generated: string;
  /** Served by `ui`, and only then: fills the window and reloads itself. */
  live: boolean;
  stamp: string;
  findings: string;
  /** How many rows `findings` holds — not how many of them are warnings. */
  findingCount: number;
  projectFindings: string;
}

const PAGE = (d: PageData): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
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
  .trimmed { margin: 0 0 12px; color: var(--text-secondary); font-size: 13px; max-width: 90ch; }

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

  /* Selecting a node dims everything that is not next to it, rather than hiding
     it: the reader keeps the sense of how big the rest of the system is, and the
     four or five names that appear are the ones the story is about. */
  .node-label--near { font-weight: 500; font-size: 11px; display: none; }
  svg.is-focused .node:not(.is-near) { opacity: 0.14; }
  svg.is-focused .edge:not(.is-near) { opacity: 0.08; }
  svg.is-focused .edge.is-near { stroke-opacity: 1; stroke-width: 2.75; }
  svg.is-focused .edge.is-near:not(.edge--calls):not(.edge--writes):not(.edge--deployed_as) {
    stroke: var(--text-secondary);
  }
  .node.is-near > .node-label--near { display: block; }

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
  .finding--info { border-left-color: var(--muted); }
  .finding .tag { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin-right: 6px; }
  .project-findings { margin-bottom: 18px; }
  .project-findings .finding { margin-top: 0; }
  .rel { font-size: 13px; display: flex; gap: 8px; padding: 2px 0; }
  .rel code { font: 11px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); min-width: 84px; }

  details { margin-top: 24px; }
  summary { cursor: pointer; color: var(--text-secondary); font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--hairline); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
${d.live ? LIVE_STYLE : ''}</style>
</head>
<body${d.live ? ` class="live" data-warnings="${d.warnings}"` : ''}>
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
${d.trimmed}
  <div class="board">
    <div class="canvas">
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="list" aria-label="Project graph">
        <g class="edges">${d.edgeSvg}</g>
        <g class="nodes">${d.nodeSvg}</g>
      </svg>
    </div>
    <aside class="panel">
      ${d.live ? `<section class="findings"><h2>Worth knowing <span class="count">${d.findingCount}</span></h2>${d.findings}</section>` : d.projectFindings}
      <div id="panel">
        <h2>Select an element</h2>
        <p>Click any node to see what it is, where it lives, and what it connects to. Everything here came from the source and from read-only queries to the network.</p>
      </div>
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
const svg = document.querySelector('svg');
const EDGES = Array.from(svg.querySelectorAll('.edge'));
const NODES = new Map(Array.from(svg.querySelectorAll('.node')).map(n => [n.dataset.id, n]));
let selected = null;

/**
 * Back to the whole graph, with nothing claiming to be chosen.
 *
 * Every path through the page goes through here, including the one that leads
 * straight back out: a node left outlined, or a finding row left highlighted,
 * describes a selection the drawing no longer shows.
 */
function clear() {
  svg.classList.remove('is-focused');
  for (const el of EDGES) el.classList.remove('is-near');
  for (const el of NODES.values()) el.classList.remove('is-near');
  if (selected) selected.classList.remove('is-selected');
  selected = null;
  for (const row of document.querySelectorAll('.finding.is-active')) row.classList.remove('is-active');
}

/** Light up one node and everything one step away from it; dim the rest. */
function focusOn(id) {
  clear();
  if (!id || !NODES.has(id)) return;

  NODES.get(id).classList.add('is-near');
  for (const edge of EDGES) {
    if (edge.dataset.from !== id && edge.dataset.to !== id) continue;
    edge.classList.add('is-near');
    const a = NODES.get(edge.dataset.from);
    const b = NODES.get(edge.dataset.to);
    if (a) a.classList.add('is-near');
    if (b) b.classList.add('is-near');
  }
  svg.classList.add('is-focused');
}

function show(id) {
  // First, so that a row whose node is not on the graph still puts back
  // whatever the last one lit up rather than adding to it.
  focusOn(id);
  const d = DETAIL[id];
  if (!d) return;
  selected = svg.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
  if (selected) selected.classList.add('is-selected');

  // Every value below came out of the vault, which is a file in the repository
  // rather than something this process produced. Kind, category and relation are
  // unions in the type and plain strings on disk, so they are escaped like the
  // free text beside them.
  const findings = d.findings.map(f =>
    '<div class="finding"><span class="tag">' + escapeHtml(f.category) + '</span>' + escapeHtml(f.message) + '</div>'
  ).join('');
  const links = d.links.map(l =>
    '<div class="rel"><code>' + (l.direction === 'out' ? '→ ' : '← ') + escapeHtml(l.kind) + '</code><span>' + escapeHtml(l.other) + '</span></div>'
  ).join('');

  panel.innerHTML =
    '<div class="kind">' + escapeHtml(d.kind) + '</div>' +
    '<h2>' + escapeHtml(d.title) + '</h2>' +
    (d.summary ? '<p>' + escapeHtml(d.summary) + '</p>' : '') +
    (d.path ? '<div class="path">' + escapeHtml(d.path) + (d.line ? ':' + escapeHtml(d.line) : '') + '</div>' : '') +
    findings +
    (links ? '<h2 style="margin-top:16px">Connections</h2>' + links : '');
  panel.scrollIntoView({ block: 'nearest' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

for (const node of NODES.values()) {
  node.addEventListener('click', () => show(node.dataset.id));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(node.dataset.id); }
  });
}

for (const row of document.querySelectorAll('.finding[data-id]')) {
  // Marked after show(), which clears whichever row was marked before it.
  row.addEventListener('click', () => {
    show(row.dataset.id);
    row.classList.add('is-active');
  });
}

// Clicking away from a node, or Escape, puts the whole graph back.
svg.addEventListener('click', (e) => { if (!e.target.closest('.node')) focusOn(null); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') focusOn(null); });
${d.live ? LIVE_SCRIPT.replace('__STAMP__', () => d.stamp) : ''}
</script>
</body>
</html>
`;

/* ------------------------------------------------------------------ *
 * Live mode
 *
 * Everything below reaches the page only through `RenderOptions.live`, and
 * everything it adds is scoped to `body.live`. A file written by
 * `graph --format html` therefore contains none of it — not the rules, not the
 * client, not the word `/events`.
 * ------------------------------------------------------------------ */

/**
 * The window is the slide.
 *
 * The committed artifact is a page: capped at 1240px, scrolled, printed. Served
 * on a projector that same cap renders the 1100-unit canvas at about 0.78x and
 * leaves the rest of a 1080p screen as margin, so the labels arrive at an
 * effective 9px and a 720p screen cuts the last contract off below the fold.
 * Filling the window scales the whole picture instead of enlarging the type,
 * which matters because the layout's own padding constants are tuned for 12px
 * text — grow the text and a long contract name clips at the canvas edge.
 */
const LIVE_STYLE = `
  body.live { overflow: hidden; }
  body.live .wrap {
    max-width: none;
    height: 100vh;
    height: 100dvh;
    padding: 16px 24px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  body.live header, body.live .legend, body.live .trimmed { flex: none; margin: 0; }
  body.live header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 24px; }
  body.live h1 { font-size: 20px; margin: 0; }
  body.live .stats { margin: 0; gap: 22px; }
  body.live .stat b { font-size: 18px; transform-origin: left center; }
  body.live .purpose { order: 1; flex-basis: 100%; margin: 0; font-size: 13px; max-width: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  body.live .board { flex: 1; min-height: 0; align-items: stretch; grid-template-columns: minmax(0,1fr) 340px; }
  body.live .canvas { display: grid; overflow: hidden; }
  body.live .canvas > svg { width: 100%; height: 100%; }
  body.live .panel { position: static; max-height: 100%; overflow-y: auto; }
  body.live details, body.live footer { display: none; }
  @media (max-width: 940px) { body.live .panel { max-height: 38vh; } }

  /* The hairlines carry \`defines\`, \`reads\` and \`tests\` — most of the
     relationships in the picture — at about 1.25:1 against the canvas, which is
     legible on a laptop and simply gone on a projector. Both values below
     measure 2.1:1 and 2.05:1 against their surface. Recessive is the intent;
     invisible is not. */
  body.live { --hairline: #b3b1a6; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) body.live { --hairline: #4d4d48; } }
  :root[data-theme="dark"] body.live { --hairline: #4d4d48; }

  .findings { margin-bottom: 18px; }
  .findings h2 { display: flex; align-items: baseline; gap: 8px; font-size: 15px; margin: 0 0 10px; }
  .findings .count { color: var(--status-critical); font-size: 20px; font-weight: 700; }
  .findings .finding {
    display: block; width: 100%; text-align: left; cursor: pointer;
    background: none; border: 0; border-left: 3px solid var(--status-warning);
    padding: 6px 8px 6px 10px; margin: 0 0 8px; font: inherit; font-size: 13px;
    color: var(--text-primary); border-radius: 0 4px 4px 0;
  }
  .findings .finding--info { border-left-color: var(--muted); }
  .findings .finding:hover, .findings .finding:focus-visible, .findings .finding.is-active {
    background: var(--border); outline: none;
  }
  .findings .tag { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
  .findings .msg { display: block; }
  .findings .where { display: block; margin-top: 3px; font: 11px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); }

  /* A count that changed is the news. The delta says what it can prove — the
     previous number — and not which finding moved, because two resolved and one
     raised is not "one resolved". */
  .stat .was { display: block; font-size: 12px; }
  .stat--warn.is-changed b { animation: pulse 1.05s ease-out 2; }
  @keyframes pulse { 0%, 100% { transform: none } 22% { transform: scale(1.3) } }

  .pill {
    position: fixed; right: 14px; bottom: 14px; z-index: 9;
    font: 11px system-ui, sans-serif; padding: 4px 10px; border-radius: 999px;
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-secondary); pointer-events: none;
  }
  /* Clear of the panel while there is one beside the canvas: 340px of panel,
     18px of gap and 24px of page padding. It passes no clicks through, but it
     was sitting on the panel's scrollbar and its last finding, and the states
     worth reading — a failed rescan, a stopped server — are the longest. */
  @media (min-width: 941px) { body.live .pill { right: 396px; } }
  @media (prefers-reduced-motion: reduce) { .stat--warn.is-changed b { animation: none } }
`;

/**
 * The reload client.
 *
 * EventSource does the hard part — it reconnects on its own — so this is a
 * listener, a comparison and `location.reload()`. It reloads on any stamp that
 * is not the one this page was built from, which covers both a rescan and a
 * window that came back to a server restarted underneath it.
 */
const LIVE_SCRIPT = `
(function () {
  const STAMP = '__STAMP__';
  const WARN_KEY = 'stellar-memory:warnings';
  const SELECTED_KEY = 'stellar-memory:selected';

  const pill = document.createElement('div');
  pill.className = 'pill';
  document.body.appendChild(pill);
  const say = (text, faded) => { pill.textContent = text; pill.style.opacity = faded ? '0.45' : '1'; };
  say('live', true);

  const now = Number(document.body.dataset.warnings);
  const before = sessionStorage.getItem(WARN_KEY);
  if (before !== null && Number(before) !== now) {
    const stat = document.querySelector('.stat--warn');
    stat.classList.add('is-changed');
    const was = document.createElement('span');
    was.className = 'was';
    was.textContent = 'was ' + before;
    stat.appendChild(was);
  }
  sessionStorage.setItem(WARN_KEY, String(now));

  // A reload otherwise drops whatever was selected, which on stage means
  // clicking your way back to where you were while the room watches.
  const remember = (e) => sessionStorage.setItem(SELECTED_KEY, e.currentTarget.dataset.id);
  for (const node of NODES.values()) node.addEventListener('click', remember);
  for (const row of document.querySelectorAll('.finding[data-id]')) row.addEventListener('click', remember);
  const kept = sessionStorage.getItem(SELECTED_KEY);
  if (kept && DETAIL[kept]) show(kept);

  const stream = new EventSource('/events');
  const check = (event) => { if (event.data && event.data !== STAMP) location.reload(); };
  stream.addEventListener('hello', check);
  stream.addEventListener('reload', check);
  stream.addEventListener('scanning', () => say('scanning…', false));
  stream.addEventListener('scanned', () => say('live', true));
  // A rescan that failed leaves the picture older than the code. Saying so at
  // full opacity, and leaving it said until a scan succeeds, is the only notice
  // in the window — the warning it pairs with is in the terminal, which during
  // a demonstration is behind it.
  stream.addEventListener('scan-failed', () => say('rescan failed — showing the last graph that worked', false));
  stream.addEventListener('open', () => say('live', true));
  // Deliberate shutdown. Without close() the browser retries a dead port every
  // half second for as long as this window stays open.
  stream.addEventListener('bye', () => {
    stream.close();
    say('server stopped', false);
    document.title = '(stopped) ' + document.title;
  });
  stream.onerror = () => say(stream.readyState === 2 ? 'disconnected' : 'reconnecting…', false);
})();`;
