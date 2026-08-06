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
 *
 * Severity is one hue and one symbol, everywhere.
 *
 * There are two severities, so there is one accent: the reserved critical red,
 * unthemed, the only status step that clears 3:1 against both surfaces (4.68
 * light, 3.62 dark). The amber this used to put down the side of a finding
 * measures 1.79:1 on the light surface — a severity cue that exists in dark
 * mode and not in light — so it is gone. An observation takes no hue at all.
 *
 * Red is also the one thing hue cannot be trusted to do here: against the
 * on-chain orange it measures ΔE 6.8 unsimulated in dark mode and 5.5 under
 * deuteranopia, so a red ring around an orange diamond is a red ring nobody
 * sees. Hence a filled triangle — a silhouette no node kind uses — carrying an
 * exclamation, drawn at the same size in the graph, the legend, the table and
 * the list. Turn the page greyscale and the warning is still the only triangle
 * on it.
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

/* ------------------------------------------------------------------ *
 * Symbols
 *
 * Drawn rather than typed. `⚠` is the obvious alternative and it is a
 * different glyph on every platform — a flat outline on one, a full-colour
 * emoji on the next, which on a projector is a yellow smudge at whatever size
 * the font decided. These are paths: same silhouette on every machine, same
 * weight beside the text, and they take the colour of the thing they sit in,
 * so one symbol serves the graph, the legend, the list and the table.
 *
 * The exclamation inside the triangle is a hole in the path rather than a mark
 * on top of it, so the symbol needs to know nothing about what is behind it.
 * ------------------------------------------------------------------ */

const TRIANGLE =
  'm14.49 12-5.33-9.33a1.33 1.33 0 0 0-2.32 0l-5.33 9.33A1.33 1.33 0 0 0 2.67 14h10.66a1.33 1.33 0 0 0 1.16-2z' +
  'M7.25 5.5h1.5v4.4h-1.5z' +
  'M8 10.95a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 1 0 0-2.1z';

const icon = (name: string, body: string): string =>
  `<svg class="ic ic--${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;

/** Needs attention. */
const ICON_WARN = icon('warn', `<path fill-rule="evenodd" d="${TRIANGLE}" />`);

/** Worth knowing, nothing to do. */
const ICON_NOTE = icon(
  'note',
  '<circle cx="8" cy="8" r="6.35" fill="none" stroke="currentColor" stroke-width="1.5" />' +
    '<path d="M8 7.4v4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />' +
    '<circle cx="8" cy="4.6" r="1" />',
);

/** Nothing to report — shown only when that is true. */
const ICON_CLEAR = icon(
  'clear',
  '<circle cx="8" cy="8" r="6.35" fill="none" stroke="currentColor" stroke-width="1.5" />' +
    '<path d="m4.9 8.2 2.2 2.3 4-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />',
);

/** Light or dark, chosen by hand when the room disagrees with the laptop. */
const ICON_THEME = icon(
  'theme',
  '<circle cx="8" cy="8" r="6.35" fill="none" stroke="currentColor" stroke-width="1.5" />' +
    '<path d="M8 1.65a6.35 6.35 0 0 1 0 12.7z" />',
);

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

      // A finding needs a mark that survives a small node in a crowded field, a
      // bad projector and a greyscale print.
      //
      // Three elements, because one is not enough. A gap ring in the surface
      // colour cuts the node out of whatever it is sitting on, so the mark that
      // follows never touches the fill and never blends into a neighbour. The
      // dashed ring is the findable part — dashes, not just red, since the ring
      // has to read on top of an orange diamond. The triangle is the part that
      // says what it means, and it is the same triangle as the legend, the list
      // and the table.
      //
      // Sized in the canvas's own units, so it grows with the drawing when the
      // window scales it up rather than staying a laptop-sized speck.
      const ring =
        p.severity === 'warn'
          ? `<circle class="ring-gap" cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(r + 5)}" />` +
            `<circle class="ring ring--warn" cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(r + 5)}" />` +
            `<g class="flag" transform="translate(${n2(p.x + r - 4.4)} ${n2(p.y - r - 13.6)}) scale(1.15)">` +
            `<path fill-rule="evenodd" d="${TRIANGLE}" /></g>`
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

      // Marked on the group as well as drawn on it, so the thinning that keeps a
      // crowded picture readable can leave the marks a reader is hunting for at
      // full strength. A ring around a node too faint to see is worse than no
      // ring: it points at nothing.
      const flagged = p.severity === 'warn' ? ' node--flagged' : '';
      return `<g class="node node--${p.group.id}${flagged}" tabindex="0" role="listitem" data-id="${esc(p.node.id)}" aria-label="${esc(p.node.title)}, ${esc(p.node.kind)}">${ring}${shape}${label}<title>${esc(p.node.title)} (${esc(p.node.kind)})</title></g>`;
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
        `<tr><td>${esc(p.node.title)}</td><td class="col-kind">${esc(p.node.kind)}</td><td class="col-path">${esc(p.node.path ?? '')}</td><td class="col-state">${p.severity === 'warn' ? `${ICON_WARN}needs attention` : ''}</td></tr>`,
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
        ? `<div class="notice">${ICON_NOTE}<p class="trimmed">Drawing ${drawn.length} of ${placed.length} elements. Contracts, on-chain entries, storage keys and anything with a finding come first; the rest are left out to keep the picture legible and the page quick to produce. All ${placed.length} are in the table below.</p></div>`
        : '',
    edgeSvg,
    nodeSvg,
    // Above 140 marks the picture stops being a diagram and starts being a
    // texture, and the things worth finding in it have to be given room by
    // taking weight off everything else.
    dense: drawn.length > 140,
    rows,
    detail: jsonForScript(Object.fromEntries(detail)),
    generated: memory.scans[memory.scans.length - 1]?.at ?? '',
    live: options.live !== undefined,
    stamp: options.live?.stamp ?? '',
    findings: findingsSection(memory, signals),
  });
}

/**
 * The findings, on screen before anything is clicked, in both pages.
 *
 * This used to be served and not committed, on the reasoning that only the
 * projected page has to be read at a distance. But the file is the copy that
 * gets attached to a pull request, and its findings were reachable only by
 * clicking a mark on the drawing — which meant the most valuable thing the tool
 * knows was the one thing the artifact would not say out loud, and said nothing
 * at all with scripting turned off. Every message is already in the file: the
 * data island beneath the page carries it so the panel can print it. Printing
 * it here too costs a few hundred bytes and is the difference between a page a
 * reviewer reads and a page a reviewer clicks around.
 *
 * Severity is a heading rather than a shade of a border. A reader who cannot
 * separate the two hues, or is looking at a washed-out projection of them, still
 * has two labelled groups in a fixed order, and a different symbol in each.
 */
function findingsSection(memory: ProjectMemory, signals: Signal[]): string {
  const byId = new Map(memory.nodes.map((n) => [n.id, n]));

  const row = (signal: Signal): string => {
    // A project-level observation has no single owner. Giving it one lets a
    // presenter click a contract and read out a claim about three of them.
    const owner = signal.scope === 'project' ? undefined : signal.nodeId ? byId.get(signal.nodeId) : undefined;
    const where = owner?.path
      ? `${owner.path}${owner.line ? `:${owner.line}` : ''}`
      : signal.scope === 'project'
        ? 'project-wide'
        : '';
    // Branched, not interpolated. `severity` is a union in the type and a plain
    // string at runtime, and this one lands inside a class attribute, where a
    // quote ends the attribute and everything after it is markup — a different
    // question from escaping text, and one `esc()` is the wrong answer to.
    // Nothing produces a third severity today; nothing has to, for this to hold.
    const grade = signal.severity === 'warn' ? 'warn' : 'info';
    // `data-id` follows the class with nothing between them: that pairing is
    // what makes a row clickable, and it is asserted as a pair.
    return (
      `<li><button type="button" class="finding finding--${grade}"${owner ? ` data-id="${esc(owner.id)}"` : ''}>` +
      `<span class="sev">${grade === 'warn' ? ICON_WARN : ICON_NOTE}</span>` +
      `<span class="said">` +
      `<span class="tag">${esc(signal.category)}</span>` +
      `<span class="msg">${esc(signal.message)}</span>` +
      (where ? `<span class="where">${esc(where)}</span>` : '') +
      `</span></button></li>`
    );
  };

  // Two filters rather than a sort: within a group the order is still the order
  // `signals()` reported, grouped by the check that produced them, and nothing
  // depends on a comparator being stable.
  const attention = signals.filter((s) => s.severity === 'warn');
  const notes = signals.filter((s) => s.severity !== 'warn');

  const group = (label: string, kind: string, held: Signal[]): string =>
    held.length === 0
      ? ''
      : `<h3 class="grade grade--${kind}">${esc(label)}</h3><ul class="finding-list">${held.map(row).join('')}</ul>`;

  const body =
    signals.length === 0
      ? `<p class="all-clear">${ICON_CLEAR}Nothing needs attention. Every contract, storage key and deployment below was checked for expiring TTLs, missing authorization and drift from what is deployed.</p>`
      : group('Needs attention', 'warn', attention) + group('Worth noting', 'note', notes);

  // What the heading counts is what the list beneath it contains, warnings and
  // observations alike — which is why the number is in plain ink. The red
  // number in the header answers a different question, how many of them need
  // attention, and it is the only red number on the page.
  return (
    `<section class="findings">` +
    `<h2>Worth knowing <span class="count">${signals.length}</span></h2>` +
    body +
    `</section>`
  );
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
  /** Enough marks on the canvas that the drawing needs help to stay readable. */
  dense: boolean;
  rows: string;
  detail: string;
  generated: string;
  /** Served by `ui`, and only then: fills the window and reloads itself. */
  live: boolean;
  stamp: string;
  findings: string;
}

/**
 * The dark column, written once.
 *
 * It has to appear under two selectors — the media query for the machine's own
 * setting, and the attribute for a reader who overrode it — and when those were
 * two literals in the stylesheet they drifted: the attribute copy was already
 * missing `--muted`, so choosing dark by hand left one ink at its light value.
 * One constant, two scopes, nothing to keep in step.
 *
 * The steps are chosen for the dark surface rather than flipped from the light
 * ones. The status red is deliberately not in here: a colour that means "needs
 * attention" and changes with the theme is not a status colour, and this one
 * clears 3:1 against both surfaces as it stands.
 */
const DARK = `
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface-1: #1a1a19;
    --sunken: #121211;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #9a988f;
    --hairline: #2c2c2a;
    --edge: #4d4d48;
    --border: rgba(255,255,255,0.14);
    --lift: none;
    --contract: #3987e5;
    --onchain: #d95926;
    --storage: #199e70;
    --other: #898781;
    --attn-text: #e66767;
    --attn-wash: rgba(208,59,59,0.14);
    --attn-edge: rgba(208,59,59,0.42);
    --clear: #0ca30c;`;

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
    --plane: #f1f1ee;
    --surface-1: #fcfcfb;
    --sunken: #f7f7f4;
    --text-primary: #0b0b0b;
    --text-secondary: #4c4b48;
    --muted: #6f6e69;
    --hairline: #e1e0d9;
    /* The relationship lines, and only those. They carry \`defines\`, \`reads\`
       and \`tests\` — most of the picture — and at the hairline value they were
       drawn in they measure about 1.25:1 against the canvas: recessive on a
       laptop, absent on a projector, and gone entirely in a printed copy. This
       measures 2.1:1 light and 2.05:1 dark. Recessive is the intent; invisible
       is not, and it was not only the projected page that suffered from it. */
    --edge: #b3b1a6;
    --border: rgba(11,11,11,0.13);
    --lift: 0 1px 1px rgba(11,11,11,0.04), 0 4px 14px rgba(11,11,11,0.05);
    --contract: #2a78d6;
    --onchain: #eb6834;
    --storage: #1baf7a;
    --other: #898781;
    /* Reserved, fixed, and the only accent on the page that means anything. */
    --attn: #d03b3b;
    /* The same red, stepped for text. The mark step is the reserved status
       colour and stays put in both modes; against the dark surface it measures
       3.62:1, which is a mark and is not a label, so red *words* take the
       palette's dark red step instead and clear 5.39:1. Light needs no second
       step — the mark colour is already 4.68:1 there. */
    --attn-text: #d03b3b;
    --attn-wash: rgba(208,59,59,0.055);
    --attn-edge: rgba(208,59,59,0.30);
    --clear: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK}
    }
  }
  :root[data-theme="dark"] {${DARK}
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--plane);
    color: var(--text-primary);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 1480px; margin: 0 auto; padding: 30px 22px 60px; }

  /* Every symbol on the page is one of four paths at one of three sizes, and
     takes the colour of whatever it sits in. */
  .ic { width: 16px; height: 16px; flex: none; display: inline-block; vertical-align: -2px; fill: currentColor; }

  /* ---- who this is, and the one number that is not inventory ---------- */

  header { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 4px 24px; align-items: start; margin-bottom: 20px; }
  .ident { grid-column: 1; grid-row: 1; min-width: 0; }
  h1 { font-size: 27px; font-weight: 650; margin: 0; letter-spacing: -0.02em; }
  .purpose { color: var(--text-secondary); margin: 6px 0 0; max-width: 80ch; font-size: 14.5px; }

  /* Three counts describe the picture and one describes the state of the
     project. Keeping them the same size was the old page's way of saying they
     were equally interesting, which they are not: the fourth is the reason
     anybody opened the file. It gets the size, the accent and the symbol; the
     other three stay quiet enough to read as context. */
  .stats { grid-column: 1 / -1; grid-row: 2; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 22px; margin-top: 16px; }
  .stat b { display: block; font-size: 19px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; }
  .stat span { display: block; color: var(--text-secondary); font-size: 12.5px; }
  .stat--warn { padding-left: 22px; border-left: 1px solid var(--border); }
  .stat--warn b { color: var(--attn-text); font-size: 27px; }
  .stat--warn span { display: flex; align-items: center; gap: 5px; font-weight: 600; color: var(--text-primary); }
  .stat--warn .ic { color: var(--attn); width: 14px; height: 14px; }
  /* Nothing to report is not an alarm. The accent is reserved for a number
     somebody has to do something about, and zero is not one. */
  .stat--none b, .stat--none .ic { color: var(--clear); }

  .theme {
    grid-column: 2; grid-row: 1; justify-self: end;
    display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
    font: inherit; font-size: 12.5px; color: var(--text-secondary);
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 999px; padding: 5px 12px;
  }
  .theme:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  .theme .ic { width: 14px; height: 14px; }

  .no-js { margin: 0 0 16px; font-size: 13.5px; color: var(--text-secondary); }

  /* ---- the figure ------------------------------------------------------ */

  .board { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 20px; align-items: start; }
  @media (max-width: 980px) { .board { grid-template-columns: 1fr; } }
  .figure { min-width: 0; }

  .legend { display: flex; flex-wrap: wrap; gap: 7px 18px; margin: 0 0 11px; font-size: 13px; color: var(--text-secondary); }
  .legend-item { display: flex; align-items: center; gap: 7px; }
  .swatch { width: 13px; height: 13px; border-radius: 50%; flex: none; }
  .swatch--square { border-radius: 2px; }
  .swatch--diamond { border-radius: 2px; transform: rotate(45deg); }
  .legend .ic { width: 15px; height: 15px; color: var(--attn); }

  /* The drawing admitting what it left out. Neutral rather than red: it is not
     a finding, and a page that shouts twice is a page nobody believes twice. */
  .notice {
    display: flex; gap: 10px; align-items: flex-start;
    margin: 0 0 12px; padding: 10px 13px;
    background: var(--sunken); border: 1px solid var(--border);
    border-left: 3px solid var(--text-secondary); border-radius: 7px;
  }
  .notice .ic { color: var(--text-secondary); margin-top: 2px; }
  .trimmed { margin: 0; color: var(--text-secondary); font-size: 13.5px; line-height: 1.5; max-width: 96ch; }

  .canvas {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow-x: auto;
    box-shadow: var(--lift);
  }
  .canvas > svg { display: block; width: 100%; height: auto; }

  .edge { stroke: var(--edge); stroke-width: 1.25; }
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

  /* Selected by element AND class, deliberately.
     \`.ring\` alone loses to \`.node--other > circle\` — one class against one class
     and a type — so for two of the four groups the finding ring was being filled
     with the group's own colour and stroked in the surface colour, and for the
     other two it was a surface-coloured circle on a surface-coloured canvas:
     invisible. The legend promised a red dashed ring the drawing never drew. */
  .node > circle.ring-gap { fill: none; stroke: var(--surface-1); stroke-width: 5; }
  .node > circle.ring { fill: none; stroke: var(--attn); stroke-width: 2.5; stroke-dasharray: 3.5 2.75; }

  /* paint-order puts the surface stroke behind the fill, which both lifts the
     triangle off whatever it overlaps and fills the exclamation — a hole in the
     path rather than a mark on top of it — with the canvas colour. */
  .flag { pointer-events: none; }
  .flag > path { fill: var(--attn); paint-order: stroke; stroke: var(--surface-1); stroke-width: 2.2; stroke-linejoin: round; }

  .node-label {
    font: 600 12px system-ui, -apple-system, "Segoe UI", sans-serif;
    fill: var(--text-primary);
    text-anchor: middle;
    paint-order: stroke;
    stroke: var(--surface-1);
    stroke-width: 3.5;
    pointer-events: none;
  }
  .node-label--onchain { font-weight: 500; font-size: 11px; fill: var(--text-secondary); }

  /* Past a certain count the drawing is a texture, and everything in it is
     equally loud. Nothing is hidden — the structure a reader came for is the
     contracts, what is deployed and what is stored, so the functions, events and
     tests that make up the bulk step back and let it through. The marks that
     carry a finding keep their full weight, which is the point of thinning the
     rest. */
  .is-dense .edge { stroke-width: 1; stroke-opacity: 0.55; }
  .is-dense .edge--calls { stroke-width: 1.5; stroke-opacity: 0.45; }
  .is-dense .node--other > circle { opacity: 0.45; }
  .is-dense .node--storage > rect { opacity: 0.8; }
  .is-dense .node.is-near > circle, .is-dense .node.is-near > rect { opacity: 1; }
  .is-dense .node--flagged > circle, .is-dense .node--flagged > rect, .is-dense .node--flagged > path { opacity: 1; }

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

  .side { min-width: 0; position: sticky; top: 18px; display: flex; flex-direction: column; gap: 14px; }

  /* ---- what the page is for -------------------------------------------- */

  .findings { min-width: 0; }
  .findings h2 { display: flex; align-items: center; gap: 9px; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 4px; }
  /* Plain ink: it counts the findings, not the warnings. The red number lives
     in the header and answers the other question. */
  .findings .count {
    font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--text-secondary); background: var(--hairline);
    border-radius: 999px; padding: 1px 9px;
  }

  /* Severity, said in words and in a fixed order, before any colour is
     involved. A heading survives a projector, a greyscale print and a reader
     who cannot separate red from grey. */
  .grade {
    display: flex; align-items: center; gap: 9px;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-secondary); margin: 16px 0 8px;
  }
  .grade::after { content: ""; flex: 1; height: 1px; background: var(--hairline); }
  .grade--warn { color: var(--attn-text); }

  .finding-list { list-style: none; margin: 0; padding: 0; }
  .finding-list li + li { margin-top: 7px; }

  .finding {
    display: flex; gap: 10px; width: 100%; text-align: left; cursor: pointer;
    font: inherit; color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border); border-left: 3px solid var(--muted);
    border-radius: 7px; padding: 10px 11px;
  }
  /* Fill, rule weight and rule pattern all move with severity, so the two
     states are still two states in greyscale. */
  .finding--warn { background: var(--attn-wash); border-color: var(--attn-edge); border-left-color: var(--attn); }
  .finding--info { border-left-style: dotted; }
  .finding .sev { flex: none; line-height: 0; }
  .finding .sev .ic { width: 17px; height: 17px; margin-top: 2px; }
  .finding--warn .sev { color: var(--attn); }
  .finding--info .sev { color: var(--muted); }
  .finding .said { min-width: 0; }
  .finding .tag { display: block; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-secondary); }
  .finding .msg { display: block; font-size: 14px; line-height: 1.42; margin-top: 2px; }
  .finding--warn .msg { font-weight: 500; }
  .finding .where { display: block; margin-top: 6px; font: 11.5px/1.35 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); word-break: break-all; }
  .finding:hover { border-color: var(--text-secondary); }
  .finding:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 2px; }
  .finding.is-active { border-color: var(--text-primary); box-shadow: inset 0 0 0 1px var(--text-primary); }

  /* Shown only when it is true, and it says what was checked — "no findings"
     and "nothing was looked for" are not the same sentence. */
  .all-clear {
    display: flex; gap: 10px; align-items: flex-start; margin: 8px 0 0;
    font-size: 13.5px; color: var(--text-secondary);
    background: var(--surface-1); border: 1px solid var(--border);
    border-left: 3px solid var(--clear); border-radius: 7px; padding: 11px 12px;
  }
  .all-clear .ic { color: var(--clear); width: 17px; height: 17px; margin-top: 1px; }

  /* ---- the element under the cursor ------------------------------------ */

  .detail {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; box-shadow: var(--lift);
  }
  .detail h2 { font-size: 15.5px; margin: 0 0 2px; }
  .detail .kind { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .detail .path { font: 12px ui-monospace, Menlo, Consolas, monospace; color: var(--text-secondary); word-break: break-all; margin: 8px 0; }
  .detail p { color: var(--text-secondary); font-size: 13.5px; margin: 6px 0; }
  .detail .finding { cursor: default; margin: 8px 0 0; }
  .rel { font-size: 13px; display: flex; gap: 9px; padding: 3px 0; }
  .rel code { font: 11.5px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); min-width: 86px; }

  /* ---- everything, for the reader who wants everything ------------------ */

  details { margin-top: 26px; }
  summary { cursor: pointer; color: var(--text-secondary); font-size: 14px; font-weight: 600; padding: 6px 0; }
  summary:hover { color: var(--text-primary); }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--hairline); }
  th { color: var(--text-secondary); font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; }
  .col-kind { color: var(--text-secondary); }
  .col-path { font: 12px ui-monospace, Menlo, Consolas, monospace; color: var(--text-secondary); word-break: break-all; }
  .col-state { color: var(--attn-text); font-weight: 600; white-space: nowrap; }
  .col-state .ic { width: 14px; height: 14px; margin-right: 5px; }
  footer { margin-top: 30px; color: var(--muted); font-size: 12px; }

  /* A page that gets attached to a pull request gets printed as often as it
     gets opened. Cards keep their edges, the accent survives greyscale as a
     rule and a triangle, and nothing breaks across a page mid-finding. */
  @media print {
    :root { --plane: #fff; --surface-1: #fff; --sunken: #fff; --border: rgba(0,0,0,0.3); --lift: none; }
    body { background: #fff; }
    .theme, .no-js { display: none; }
    .board { display: block; }
    .side { position: static; margin-top: 20px; }
    .finding, .notice, .all-clear, tr { break-inside: avoid; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
${d.live ? LIVE_STYLE : ''}</style>
</head>
<body${d.live ? ` class="live" data-warnings="${d.warnings}"` : ''}>
<div class="wrap">
  <header>
    <div class="ident">
      <h1>${d.project}</h1>
      ${d.purpose ? `<p class="purpose">${d.purpose}</p>` : ''}
    </div>
    <button type="button" class="theme" aria-label="Switch between the light and dark palette">${ICON_THEME}<span class="theme-label">Theme</span></button>
    <div class="stats">
      <div class="stat"><b>${d.contracts}</b><span>contracts</span></div>
      <div class="stat"><b>${d.nodes}</b><span>elements</span></div>
      <div class="stat"><b>${d.edges}</b><span>relationships</span></div>
      <div class="stat${d.warnings === 0 ? ' stat--none' : ''} stat--warn"><b>${d.warnings}</b><span>${d.warnings === 0 ? ICON_CLEAR : ICON_WARN}need attention</span></div>
    </div>
  </header>

  <noscript><p class="no-js">Scripting is off, so the drawing will not respond to a click. Everything it would have told you is already written out: the findings beside it, and every element in the table below.</p></noscript>

  <div class="board">
    <div class="figure">
      <div class="legend" role="list">
        <span class="legend-item" role="listitem"><span class="swatch" style="background: var(--contract)"></span> Contract</span>
        <span class="legend-item" role="listitem"><span class="swatch swatch--diamond" style="background: var(--onchain)"></span> On-chain</span>
        <span class="legend-item" role="listitem"><span class="swatch swatch--square" style="background: var(--storage)"></span> Storage key</span>
        <span class="legend-item" role="listitem"><span class="swatch" style="background: var(--other)"></span> Function, event, error, test</span>
        <span class="legend-item" role="listitem">${ICON_WARN} Needs attention</span>
      </div>
${d.trimmed}
      <div class="canvas">
        <svg class="graph${d.dense ? ' is-dense' : ''}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="list" aria-label="Project graph">
          <g class="edges">${d.edgeSvg}</g>
          <g class="nodes">${d.nodeSvg}</g>
        </svg>
      </div>
    </div>
    <aside class="side">
      ${d.findings}
      <div id="panel" class="detail">
        <h2>Select an element</h2>
        <p>Click any node — or any finding — to see what it is, where it lives, and what it connects to. Everything here came from the source and from read-only queries to the network.</p>
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
const WARN_ICON = '${ICON_WARN}';
const NOTE_ICON = '${ICON_NOTE}';
const panel = document.getElementById('panel');
// Qualified, and it has to stay that way. The legend and the findings list draw
// their glyphs as inline <svg class="ic">, and those come first in the document,
// so a bare querySelector('svg') returns a 16px icon. Nothing then throws —
// querySelectorAll('.node') on an icon is simply empty — so every click handler
// below is attached to nothing and the page looks perfectly fine until you
// click it.
const svg = document.querySelector('svg.graph');
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
  // The severity class is branched rather than interpolated: it is a union in
  // the type and a plain string on disk, and this one ends up inside a class
  // attribute, where escaping is not the same question as escaping text.
  const findings = d.findings.map(f =>
    '<div class="finding finding--' + (f.severity === 'warn' ? 'warn' : 'info') + '">' +
    '<span class="sev">' + (f.severity === 'warn' ? WARN_ICON : NOTE_ICON) + '</span>' +
    '<span class="said"><span class="tag">' + escapeHtml(f.category) + '</span>' +
    '<span class="msg">' + escapeHtml(f.message) + '</span></span></div>'
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

// Every row, not only the ones that own a node: a finding about the project as
// a whole has nothing to select, and clicking it puts the whole graph back,
// which is exactly what it is a finding about. A row that did nothing at all
// would be a button that lies.
for (const row of document.querySelectorAll('.finding')) {
  // Marked after show(), which clears whichever row was marked before it.
  row.addEventListener('click', () => {
    show(row.dataset.id);
    row.classList.add('is-active');
  });
}

// Clicking away from a node, or Escape, puts the whole graph back.
svg.addEventListener('click', (e) => { if (!e.target.closest('.node')) focusOn(null); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') focusOn(null); });

/**
 * Light or dark, when the room disagrees with the laptop.
 *
 * The palette already follows the machine's own setting, which is right nearly
 * everywhere and wrong in the one room this page was built for: a projector
 * that washes out a dark page, or a lit hall that glares off a light one, with
 * the laptop's preference set weeks ago. The stylesheet was already written to
 * be overridden in both directions, so this is a stamp on the root element.
 *
 * Everything here is guarded. The page's script is also run headless against a
 * minimal DOM, and a redesign that threw on a missing element there would take
 * the click handling above with it.
 */
(function () {
  const root = document.documentElement;
  const button = document.querySelector('.theme');
  if (!root || !root.dataset || !button) return;
  const label = button.querySelector ? button.querySelector('.theme-label') : null;
  const wantsDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  let dark = root.dataset.theme ? root.dataset.theme === 'dark' : wantsDark;
  const paint = () => { if (label) label.textContent = dark ? 'Light' : 'Dark'; };
  paint();
  button.addEventListener('click', () => {
    dark = !dark;
    root.dataset.theme = dark ? 'dark' : 'light';
    paint();
  });
})();
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
    padding: 14px 22px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* One band across the top instead of two: the window has a fixed height and
     every row spent on the header is a row taken off the drawing. */
  body.live header { display: flex; flex-wrap: nowrap; align-items: center; gap: 22px; margin: 0; flex: none; }
  body.live .ident { display: flex; align-items: baseline; gap: 14px; flex: 1 1 auto; min-width: 0; order: 1; }
  body.live h1 { font-size: 21px; flex: none; white-space: nowrap; }
  body.live .purpose { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 13px; max-width: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  body.live .stats { margin: 0; gap: 4px 20px; flex: none; align-items: center; order: 2; }
  body.live .stat b { font-size: 19px; transform-origin: left center; }
  body.live .stat--warn b { font-size: 30px; }
  body.live .stat--warn { padding-left: 20px; }
  body.live .theme { order: 3; flex: none; }

  body.live .board { flex: 1; min-height: 0; align-items: stretch; gap: 18px;
    grid-template-columns: minmax(0,1fr) 400px; }
  body.live .figure { display: flex; flex-direction: column; min-height: 0; }
  body.live .legend, body.live .notice { flex: none; }
  body.live .canvas { flex: 1; min-height: 0; display: grid; overflow: hidden; }
  body.live .canvas > svg { width: 100%; height: 100%; }
  body.live .side { position: static; min-height: 0; overflow-y: auto; }
  body.live details, body.live footer { display: none; }
  @media (max-width: 980px) { body.live .side { max-height: 38vh; } }

  /* Read from the back of a room rather than from a chair. The drawing scales
     with the window on its own — it is one viewBox — so what is left is the
     text beside it, and the finding is the text that has to arrive. */
  body.live .findings h2 { font-size: 19px; }
  body.live .findings .count { font-size: 13.5px; }
  body.live .grade { font-size: 12px; margin: 12px 0 7px; }
  body.live .finding { padding: 9px 11px; gap: 9px; }
  body.live .finding-list li + li { margin-top: 6px; }
  body.live .finding .tag { font-size: 11px; }
  body.live .finding .msg { font-size: 15px; line-height: 1.36; }
  body.live .finding .where { font-size: 12px; margin-top: 4px; }
  body.live .all-clear { font-size: 15px; }

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
  /* Clear of the column while there is one beside the canvas: 400px of findings,
     18px of gap and 22px of page padding. It passes no clicks through, but it
     was sitting on the column's scrollbar and its last finding, and the states
     worth reading — a failed rescan, a stopped server — are the longest. */
  @media (min-width: 981px) { body.live .pill { right: 454px; } }
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
