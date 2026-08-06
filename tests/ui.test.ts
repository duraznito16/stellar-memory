/**
 * `stellar-memory ui` — the parts that can be checked without a browser.
 *
 * Two properties matter more than the rest and neither is visible by looking at
 * the window:
 *
 *   - the file `graph --format html` writes must contain no reference to a
 *     server, because it gets committed and opened months later on a machine
 *     where nothing is listening;
 *   - the server must refuse anything that did not come from itself, because
 *     what it publishes is a map of somebody's private source tree.
 *
 * Both are one-line regressions and neither fails loudly, so they are asserted
 * here rather than trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// From `dist` rather than `src`: these modules import each other through the
// `.js` specifiers the compiler expects, which Node's type stripping does not
// rewrite. It also means what is asserted here is the JavaScript that ships.
import { renderGraphHtml } from '../dist/store/html.js';
import { startUiServer, type RenderedPage, type UiServer } from '../dist/ui/serve.js';
import { debounce, serialised } from '../dist/ui/watch.js';
import { signals, type Signal } from '../dist/core/query.js';
import type { ProjectMemory } from '../dist/core/types.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const demo = path.join(repoRoot, 'demo', 'private-payroll');
const entry = path.join(repoRoot, 'dist', 'index.js');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * A memory small enough to reason about, and awkward enough to matter.
 * ------------------------------------------------------------------ */

function fixture(overrides: Partial<ProjectMemory['nodes'][number]> = {}): ProjectMemory {
  const stamp = '2026-01-01T00:00:00.000Z';
  return {
    version: 1,
    project: { name: 'fixture', root: '/tmp/fixture', networks: ['testnet'] },
    nodes: [
      {
        id: 'contract:Payroll',
        kind: 'contract',
        title: 'Payroll',
        path: 'contracts/payroll/src/lib.rs',
        provenance: [],
        firstSeen: stamp,
        lastChanged: stamp,
        ...overrides,
      },
      {
        id: 'storage:Payroll.Admin',
        kind: 'storage',
        title: 'DataKey::Admin',
        provenance: [],
        firstSeen: stamp,
        lastChanged: stamp,
      },
    ],
    edges: [
      { from: 'contract:Payroll', to: 'storage:Payroll.Admin', kind: 'defines', provenance: [] },
    ],
    scans: [{ at: stamp, nodeCount: 2, edgeCount: 1, changed: [] }],
  };
}

/* ------------------------------------------------------------------ *
 * The committed artifact
 * ------------------------------------------------------------------ */

test('the written page carries nothing that points at a server', () => {
  const html = renderGraphHtml(fixture(), []);

  // Each of these would turn a file somebody committed into one that retries a
  // dead port, or names the machine it was produced on.
  for (const forbidden of ['EventSource', '/events', '127.0.0.1', 'localhost', 'body.live', '__STAMP__', 'retry:']) {
    assert.ok(!html.includes(forbidden), `a committed page must not mention ${forbidden}`);
  }
  assert.ok(!/https?:\/\//.test(html), 'no absolute URL belongs in a self-contained file');
});

test('the live client arrives only when it is asked for', () => {
  const memory = fixture();
  const html = renderGraphHtml(memory, [], { live: { stamp: 'abc123' } });

  assert.ok(html.includes('EventSource'), 'the served page reconnects to the stream');
  assert.ok(html.includes("new EventSource('/events')"));
  assert.ok(html.includes("const STAMP = 'abc123'"), 'the page carries the stamp it was built from');
  assert.ok(html.includes('class="live"'), 'live mode fills the window');
  // The default is what protects the committed file, so it is asserted from the
  // same memory rather than from a separate fixture that might have drifted.
  assert.ok(!renderGraphHtml(memory, []).includes('EventSource'));
});

test('the same memory produces the same bytes, whatever the host', () => {
  // The file is committed beside the vault it describes, so a second render of
  // an unchanged project has to be a zero-line diff. Everything here is seeded
  // or rounded except the order of the table, which until this test compared
  // strings with the runtime's locale — ICU plus LANG — and put a row in a
  // different place on a machine configured in Swedish or Turkish.
  const memory = fixture();
  assert.equal(renderGraphHtml(memory, []), renderGraphHtml(memory, []));

  const named = fixture();
  named.nodes = [
    { ...named.nodes[0]!, id: 'storage:z', kind: 'storage', title: 'Zebra' },
    { ...named.nodes[0]!, id: 'storage:o', kind: 'storage', title: 'Ödeme' },
    { ...named.nodes[0]!, id: 'storage:a', kind: 'storage', title: 'Ahorro-Año' },
    { ...named.nodes[0]!, id: 'storage:b', kind: 'storage', title: 'Ahorro-Ano' },
  ];
  named.edges = [];

  // Code units, so `Ö` (U+00D6) follows `Z` and `ñ` follows `n` on every
  // machine. A collator would put both the other way round, and which way round
  // would depend on where the process is running.
  const titles = [...renderGraphHtml(named, []).matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Ahorro-Ano', 'Ahorro-Año', 'Zebra', 'Ödeme']);
});

test('both pages carry a content security policy', () => {
  // The header `ui` sends only protects the served copy. The written file is
  // opened over file://, where a policy has to travel inside the document.
  for (const html of [renderGraphHtml(fixture(), []), renderGraphHtml(fixture(), [], { live: { stamp: 'x' } })]) {
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  }
});

/* ------------------------------------------------------------------ *
 * A workspace big enough to stall the server
 * ------------------------------------------------------------------ */

type Node = ProjectMemory['nodes'][number];

/**
 * Twenty contracts with the parts twenty contracts have.
 *
 * The layout is all-pairs over 420 iterations, so this shape — about 2100
 * drawable nodes — is the one that used to take the better part of a minute
 * inside a synchronous render, with `ui` answering nothing for the duration.
 */
function workspace(): ProjectMemory {
  const stamp = '2026-01-01T00:00:00.000Z';
  const nodes: Node[] = [];
  const edges: ProjectMemory['edges'] = [];

  const add = (id: string, kind: Node['kind'], title: string, owner?: string): void => {
    nodes.push({
      id,
      kind,
      title,
      path: `contracts/${title}/src/lib.rs`,
      provenance: [],
      firstSeen: stamp,
      lastChanged: stamp,
    });
    if (owner) edges.push({ from: owner, to: id, kind: 'defines', provenance: [] });
  };

  for (let c = 0; c < 20; c++) {
    const contract = `contract:C${c}`;
    add(contract, 'contract', `C${c}`);
    add(`deployment:C${c}.testnet`, 'deployment', `C${c} on testnet`, contract);
    for (let i = 0; i < 60; i++) add(`function:C${c}.f${i}`, 'function', `f${i}`, contract);
    for (let i = 0; i < 25; i++) add(`storage:C${c}.k${i}`, 'storage', `DataKey::K${i}`, contract);
    for (let i = 0; i < 10; i++) add(`event:C${c}.e${i}`, 'event', `e${i}`, contract);
    for (let i = 0; i < 4; i++) add(`error:C${c}.x${i}`, 'error', `x${i}`, contract);
    for (let i = 0; i < 6; i++) add(`test:C${c}.t${i}`, 'test', `t${i}`, contract);
  }

  return {
    version: 1,
    project: { name: 'workspace', root: '/tmp/workspace', networks: ['testnet'] },
    nodes,
    edges,
    scans: [{ at: stamp, nodeCount: nodes.length, edgeCount: edges.length, changed: [] }],
  };
}

test('a workspace too large to draw is trimmed, and says so', () => {
  const memory = workspace();
  // A function is in the group the trim drops, so this is the one that has to
  // survive it: a warning the header counts and the picture cannot show is the
  // failure this whole tool exists to prevent.
  const found: Signal[] = [
    { severity: 'warn', category: 'ttl', message: 'a persistent key is never extended', nodeId: 'function:C19.f59' },
    { severity: 'info', category: 'tests', message: 'No tests reference f0.', nodeId: 'function:C0.f0' },
  ];

  const started = Date.now();
  const html = renderGraphHtml(memory, found);
  const took = Date.now() - started;

  const drawn = (html.match(/<g class="node /g) ?? []).length;
  const elements = (html.match(/<tr><td>/g) ?? []).length;
  assert.equal(elements, 2140, 'every element is still in the table');
  assert.ok(drawn <= 300, `the drawing is capped, found ${drawn}`);
  // Unbounded this is 9.6e8 pair evaluations and 18 seconds, during which `ui`
  // renders synchronously and dispatches no event to an open window.
  assert.ok(took < 10_000, `the layout has to stay interactive, took ${took}ms`);

  assert.match(html, new RegExp(`<p class="trimmed">Drawing ${drawn} of 2140 elements`), 'a trimmed graph says so');
  for (const id of ['function:C19.f59', 'function:C0.f0']) {
    assert.ok(html.includes(`data-id="${id}"`), `${id} carries a finding and must stay on the graph`);
  }
  assert.equal(
    (html.match(/class="ring ring--warn"/g) ?? []).length,
    1,
    'the ring the header counts is drawn',
  );

  // Still the same picture twice: the filter keeps memory order and the sort
  // that puts findings first is stable.
  assert.equal(renderGraphHtml(memory, found), html);
  assert.ok(!renderGraphHtml(fixture(), []).includes('class="trimmed"'), 'and a small project is untouched');
});

/* ------------------------------------------------------------------ *
 * Escaping — the vault is a file in someone else's repository
 * ------------------------------------------------------------------ */

/** The `<script>` element, where the rules are JavaScript's and not HTML's. */
function island(html: string): string {
  return html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
}

test('a node title cannot close the script element it is embedded in', () => {
  const memory = fixture({ title: '</script><img src=x onerror=alert(1)>' });
  const html = renderGraphHtml(memory, []);

  assert.ok(!html.includes('</script><img'), 'the data island must not be escapable');
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, 'exactly one script element');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'the title survives, escaped');

  // U+2028 is legal raw inside a JSON string and was not legal inside a
  // JavaScript one until ES2019. Harmless as page text, so only the island has
  // to be clean of it.
  const separators = renderGraphHtml(fixture({ title: 'a\u2028b' }), []);
  assert.ok(!island(separators).includes('\u2028'), 'the island is JavaScript, whatever the JSON allows');
  assert.ok(island(separators).includes('a\\u2028b'));
});

test('every value the panel writes as markup is escaped', () => {
  // `kind` is a union in the types and a plain string on disk; the vault is
  // loaded with a cast, so nothing between the file and here validates it.
  const html = renderGraphHtml(fixture({ kind: '<img src=q onerror=alert(2)>' as 'contract' }), []);
  assert.ok(!html.includes('<img src=q'), 'no raw markup from the vault, anywhere');

  // The three places the panel builds HTML by concatenation.
  for (const expression of ['escapeHtml(d.kind)', 'escapeHtml(f.category)', 'escapeHtml(l.kind)']) {
    assert.ok(island(html).includes(expression), `${expression} must be escaped like the fields beside it`);
  }
});

test('a severity cannot break out of the class attribute it is written into', () => {
  // Severity is the one field that lands inside a class rather than in text,
  // and a quote there ends the attribute — which `esc()` would let through,
  // because escaping text and escaping an attribute value are not the same
  // question. Nothing produces a third severity today; the page does not depend
  // on that staying true, and this is what says so.
  const hostile: Signal[] = [
    { severity: '"><img src=x onerror=alert(1)>' as 'warn', category: 'ttl', message: 'a message', scope: 'project' },
  ];

  for (const html of [renderGraphHtml(fixture(), hostile), renderGraphHtml(fixture(), hostile, { live: { stamp: 'x' } })]) {
    assert.ok(!html.includes('<img src=x'), 'no raw markup arrives through a severity');
    assert.equal((html.match(/<\/script>/g) ?? []).length, 1, 'exactly one script element');
    assert.ok(html.includes('class="finding finding--info"'), 'and an unknown severity reads as the quieter of the two');
  }
});

/* ------------------------------------------------------------------ *
 * The page's own script, run
 *
 * What a class list says after a click is not in the markup the server wrote,
 * so it cannot be asserted from the HTML — and a node left outlined under a
 * drawing that no longer highlights it is exactly the kind of thing nobody
 * notices until they are presenting.
 * ------------------------------------------------------------------ */

interface Fake {
  /** Element name, so a tag selector can be resolved the way a browser resolves it. */
  tag: string;
  dataset: Record<string, string>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  addEventListener(type: string, fn: (event: unknown) => void): void;
  fire(type: string, event?: Record<string, unknown>): void;
  closest(selector: string): Fake | null;
  scrollIntoView(): void;
  appendChild(child: Fake): void;
  innerHTML: string;
  textContent: string;
  className: string;
  style: Record<string, string>;
}

/** `.node`, `.finding[data-id]`, `.node[data-id="x"]` — all the page ever asks for. */
function matches(el: Fake, selector: string): boolean {
  // A leading tag name counts. Without it this harness answered `svg` with
  // whatever the page wanted rather than with the first svg in the document,
  // which is how a bare `querySelector('svg')` passed every test here while
  // returning a 16px legend icon in a real browser.
  const tag = /^[a-z]+/.exec(selector)?.[0];
  if (tag && el.tag !== tag) return false;

  const parts = selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
  return parts.every((part) => {
    if (part.startsWith('.')) return el.classList.contains(part.slice(1));
    const found = /^\[data-([\w-]+)(?:="(.*)")?\]$/.exec(part);
    if (!found) return false;
    const held = el.dataset[found[1]!];
    // CSS.escape put backslashes in; the id on the element never had them.
    return held !== undefined && (found[2] === undefined || held === found[2].replace(/\\(.)/g, '$1'));
  });
}

function element(classes: string, dataset: Record<string, string> = {}, tag = 'div'): Fake {
  const held = new Set(classes.split(' ').filter(Boolean));
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const el: Fake = {
    tag,
    dataset,
    classList: { add: (c) => void held.add(c), remove: (c) => void held.delete(c), contains: (c) => held.has(c) },
    addEventListener: (type, fn) => void handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    fire: (type, event) => {
      for (const fn of handlers.get(type) ?? []) fn({ target: el, currentTarget: el, preventDefault() {}, ...event });
    },
    closest: (selector) => (matches(el, selector) ? el : null),
    scrollIntoView: () => undefined,
    appendChild: () => undefined,
    innerHTML: '',
    textContent: '',
    className: '',
    style: {},
  };
  return el;
}

/**
 * Build the DOM out of the rendered markup, then run the page's script over it.
 *
 * Out of the markup rather than out of the fixture, deliberately: a node the
 * renderer stopped drawing has to stop being clickable here too.
 */
function open(html: string): {
  node: (id: string) => Fake;
  finding: (index: number) => Fake;
  svg: Fake;
  panel: Fake;
  press: (key: string) => void;
} {
  const nodes = [...html.matchAll(/<g class="(node[^"]*)"[^>]*data-id="([^"]*)"/g)].map((m) =>
    element(m[1]!, { id: m[2]! }),
  );
  const edges = [...html.matchAll(/<line class="(edge[^"]*)" data-from="([^"]*)" data-to="([^"]*)"/g)].map((m) =>
    element(m[1]!, { from: m[2]!, to: m[3]! }),
  );
  const findings = [...html.matchAll(/class="(finding[^"]*)" data-id="([^"]*)"/g)].map((m) =>
    element(m[1]!, { id: m[2]! }),
  );

  // The legend glyphs and the theme toggle are inline <svg> as well, and they
  // are drawn before the graph. Their presence is the whole reason the page has
  // to ask for `svg.graph`: a browser answers `svg` with the first one, which is
  // a 16px icon containing no nodes and raising no error.
  const icons = [...html.matchAll(/<svg class="(ic[^"]*)"/g)].map((m) => element(m[1]!, {}, 'svg'));
  const svg = element('graph', {}, 'svg');
  const panel = element('panel');
  const body = element('live', { warnings: html.match(/data-warnings="(\d+)"/)?.[1] ?? '0' });
  const inSvg = [...nodes, ...edges];
  // Document order, because `querySelector` returns the first match in it.
  const everything = [...icons, svg, ...inSvg, ...findings, panel, body];
  const keys: ((event: unknown) => void)[] = [];

  const document = {
    title: 'fixture',
    body,
    getElementById: (id: string) => (id === 'panel' ? panel : null),
    querySelector: (s: string) => everything.find((el) => matches(el, s)) ?? null,
    querySelectorAll: (s: string) => everything.filter((el) => matches(el, s)),
    createElement: () => element(''),
    addEventListener: (_type: string, fn: (event: unknown) => void) => void keys.push(fn),
  };
  Object.assign(svg, {
    querySelector: (s: string) => inSvg.find((el) => matches(el, s)) ?? null,
    querySelectorAll: (s: string) => inSvg.filter((el) => matches(el, s)),
  });

  const store = new Map<string, string>();
  const context = vm.createContext({
    document,
    CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => '\\' + c) },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    // The reload client must not reach for a socket that is not there.
    EventSource: class {
      readyState = 0;
      addEventListener(): void {}
      close(): void {}
    },
    location: { reload: () => undefined },
  });
  vm.runInContext(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')), context);

  return {
    node: (id) => nodes.find((el) => el.dataset['id'] === id)!,
    finding: (index) => findings[index]!,
    svg,
    panel,
    press: (key) => {
      for (const fn of keys) fn({ key, preventDefault() {} });
    },
  };
}

test('the page finds its graph even though icons are drawn before it', () => {
  // Shipped broken in 0.2.5. The script opened with `querySelector('svg')`,
  // which was written when the graph was the only svg on the page. Once the
  // legend and the findings list gained inline glyphs, that returned a 16px
  // icon — and `querySelectorAll('.node')` on an icon is empty rather than an
  // error, so every click handler was attached to nothing. The page rendered,
  // hovered and looked finished; only clicking did nothing at all.
  const html = renderGraphHtml(fixture(), [], { live: { stamp: 'x' } });

  const firstSvg = html.slice(html.indexOf('<svg'), html.indexOf('<svg') + 40);
  assert.ok(
    !firstSvg.includes('class="graph'),
    'this test is only worth running while some icon is still drawn first',
  );
  // The assignment, not any occurrence: the comment above it names the wrong
  // selector on purpose, and prose should not be able to fail a test about code.
  assert.match(
    island(html),
    /const svg = document\.querySelector\('svg\.graph'\)/,
    'the graph must be asked for by class; a bare tag selector reaches an icon',
  );

  // And the behaviour that depends on it, not just the spelling.
  const page = open(html);
  const before = page.panel.innerHTML;
  page.node('storage:Payroll.Admin').fire('click');
  assert.notEqual(page.panel.innerHTML, before, 'clicking a node must fill the panel');
});

test('Escape leaves nothing behind claiming to be selected', () => {
  const page = open(renderGraphHtml(fixture(), [], { live: { stamp: 'x' } }));
  const node = page.node('storage:Payroll.Admin');

  node.fire('click');
  assert.ok(node.classList.contains('is-selected'), 'a click selects');
  assert.ok(page.svg.classList.contains('is-focused'));
  assert.ok(page.panel.innerHTML.includes('DataKey::Admin'), 'and the panel says which one');

  page.press('Escape');
  assert.ok(!page.svg.classList.contains('is-focused'), 'the graph comes back');
  assert.ok(!node.classList.contains('is-selected'), 'and the thick outline goes with it');

  // Clicking off a node is the other way out of the same state.
  node.fire('click');
  page.svg.fire('click', { target: page.svg });
  assert.ok(!node.classList.contains('is-selected'));
});

test('the findings list never highlights a row the graph is not showing', () => {
  const found: Signal[] = [
    { severity: 'warn', category: 'ttl', message: 'a persistent key is never extended', nodeId: 'storage:Payroll.Admin' },
    { severity: 'info', category: 'tests', message: 'No tests reference Payroll.', nodeId: 'contract:Payroll' },
  ];
  const page = open(renderGraphHtml(fixture(), found, { live: { stamp: 'x' } }));

  page.finding(0).fire('click');
  assert.ok(page.finding(0).classList.contains('is-active'));
  assert.ok(page.node('storage:Payroll.Admin').classList.contains('is-selected'));

  page.finding(1).fire('click');
  assert.ok(!page.finding(0).classList.contains('is-active'), 'one row at a time');
  assert.ok(!page.node('storage:Payroll.Admin').classList.contains('is-selected'), 'and one node at a time');
  assert.ok(page.finding(1).classList.contains('is-active'));
  assert.ok(page.node('contract:Payroll').classList.contains('is-selected'));

  page.press('Escape');
  assert.ok(!page.finding(1).classList.contains('is-active'), 'Escape puts the list back too');
  assert.ok(!page.node('contract:Payroll').classList.contains('is-selected'));
});

/* ------------------------------------------------------------------ *
 * The findings panel says what it shows
 * ------------------------------------------------------------------ */

test('the findings heading counts the rows printed beneath it', () => {
  const mixed: Signal[] = [
    { severity: 'warn', category: 'ttl', message: 'a persistent key is never extended', nodeId: 'contract:Payroll' },
    { severity: 'info', category: 'tests', message: 'No tests reference Payroll.', nodeId: 'contract:Payroll' },
    { severity: 'warn', category: 'tests', message: 'mock_all_auths everywhere', scope: 'project' },
  ];
  // Both pages, since the written file lists them too: the heading counting one
  // set while the list beneath it shows another is the same misstatement in
  // either copy.
  for (const html of [renderGraphHtml(fixture(), mixed, { live: { stamp: 'x' } }), renderGraphHtml(fixture(), mixed)]) {
    const heading = html.match(/Worth knowing <span class="count">(\d+)<\/span>/);
    const rows = (html.match(/<button type="button" class="finding /g) ?? []).length;
    assert.equal(rows, mixed.length, 'every finding is listed');
    assert.equal(Number(heading?.[1]), rows, 'the number and the list describe the same set');
  }
});

test('a finding that belongs to no element is still on the page', () => {
  // It carries no nodeId, so it draws no ring and fills no table row. Counting
  // it in the header and then showing it nowhere is the failure this whole tool
  // exists to avoid.
  const wide: Signal[] = [
    { severity: 'warn', category: 'tests', message: 'Every test module calls mock_all_auths.', scope: 'project' },
  ];
  const file = renderGraphHtml(fixture(), wide);

  assert.match(file, /stat--warn"><b>1<\/b>/, 'the header counts it');
  assert.ok(file.includes('Every test module calls mock_all_auths.'), 'and the page can substantiate the count');
  assert.ok(file.includes('project-wide'), 'and says it belongs to the project rather than to a node');
});

test('a project with nothing wrong says so, rather than showing an empty list', () => {
  // The absence of findings and the absence of checking look identical if the
  // page just prints nothing, and only one of them is good news.
  const quiet = renderGraphHtml(fixture(), []);

  assert.match(quiet, /stat--warn"><b>0<\/b>/);
  assert.ok(quiet.includes('Nothing needs attention.'), 'the page says it found nothing');
  assert.ok(quiet.includes('class="all-clear"'), 'and marks it as a state rather than a finding');
  assert.ok(!quiet.includes('class="grade grade--warn"'), 'with no severity heading over an empty list');
  // Zero is not an alarm, so it does not wear the accent reserved for one.
  assert.ok(quiet.includes('class="stat stat--none stat--warn"'));
});

/** The page's own escaping, so a message can be looked for as it is printed. */
function asPrinted(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

test('the demo page shows every finding it counts', () => {
  // The real vault, in the shape a reader will see it. This used to reconcile
  // two partial views — a ring for the findings that owned a node, a block for
  // the one that did not — because the written file listed nothing. It lists
  // everything now, so the header's number and the list are the same set, and
  // the assertion is the stronger one: not "visible somewhere" but "written
  // out, in words, where a reader will be looking".
  const memory = JSON.parse(
    readFileSync(path.join(demo, '.stellar-memory', 'index.json'), 'utf8'),
  ) as ProjectMemory;
  const found = signals(memory);
  const html = renderGraphHtml(memory, found);

  const claimed = Number(html.match(/stat--warn"><b>(\d+)<\/b>/)?.[1]);
  assert.equal(claimed, found.filter((s) => s.severity === 'warn').length);

  const listed = (html.match(/class="finding finding--warn"/g) ?? []).length;
  assert.equal(listed, claimed, 'every warning the header counts is a row on the page');

  for (const signal of found) {
    assert.ok(html.includes(asPrinted(signal.message)), `the page says: ${signal.message}`);
  }

  // And the drawing still points at the ones that belong to something it drew.
  const owners = new Set(
    found.filter((s) => s.severity === 'warn' && s.scope !== 'project' && s.nodeId).map((s) => s.nodeId),
  );
  const rings = (html.match(/class="ring ring--warn"/g) ?? []).length;
  assert.equal(rings, owners.size, 'and every element carrying one is ringed');
});

test('the findings are readable with scripting turned off', () => {
  // The panel needs a script and always did. The findings must not: the file is
  // opened over file:// by people with scripting disabled, printed to PDF, and
  // pasted into review tools that strip <script> outright. A message that only
  // exists inside the data island is a message that page cannot show.
  const found: Signal[] = [
    { severity: 'warn', category: 'ttl', message: 'a persistent key is never extended', nodeId: 'storage:Payroll.Admin' },
    { severity: 'info', category: 'tests', message: 'No tests reference Payroll.', nodeId: 'contract:Payroll' },
    { severity: 'warn', category: 'tests', message: 'mock_all_auths everywhere', scope: 'project' },
  ];

  for (const html of [renderGraphHtml(fixture(), found), renderGraphHtml(fixture(), found, { live: { stamp: 'x' } })]) {
    const markup = html.slice(0, html.indexOf('<script>'));
    for (const signal of found) {
      assert.ok(markup.includes(asPrinted(signal.message)), `${signal.message} is in the markup, not only the island`);
    }
    // Severity is not carried by a colour a script paints on later: it is two
    // headings, in a fixed order, in the document as written.
    assert.ok(markup.includes('class="grade grade--warn">Needs attention'), 'the warnings are under a heading that says so');
    assert.ok(
      markup.indexOf('grade--warn') < markup.indexOf('grade--note'),
      'and the ones that need attention come first',
    );
  }
});

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function request(server: UiServer, pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: pathname, method, headers: { host: `127.0.0.1:${server.port}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A server whose page is whatever `stamp` currently says, so refresh() is testable. */
function stubServer(): { start: () => Promise<UiServer>; set: (stamp: string) => void } {
  let stamp = 'first';
  return {
    set: (next: string) => (stamp = next),
    start: () =>
      startUiServer({
        port: 0,
        render: (): Promise<RenderedPage> => Promise.resolve({ html: `<html>${stamp}</html>`, stamp }),
      }),
  };
}

test('serves the page on loopback and nothing else anywhere else', async () => {
  const stub = stubServer();
  const server = await stub.start();
  try {
    assert.ok(server.port > 0, 'an ephemeral port is a real port');
    assert.equal(server.url, `http://127.0.0.1:${server.port}/`);

    const page = await request(server, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'nothing cross-origin may read this');

    // Both routes are literals, so everything else is a 404 rather than a path
    // that reaches a file system.
    for (const missing of ['/index.json', '/..%2f..%2fetc/passwd', '/.stellar-memory/index.json', '/events/']) {
      assert.equal((await request(server, missing)).status, 404, `${missing} must not be served`);
    }
    assert.equal((await request(server, '/', {}, 'POST')).status, 405);

    const head = await request(server, '/', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '', 'HEAD carries the headers and no body');
  } finally {
    await server.close();
  }
});

test('refuses a request that did not come from itself', async () => {
  const stub = stubServer();
  const server = await stub.start();
  try {
    // A page on evil.com whose name resolves to 127.0.0.1 reaches this socket.
    // What it cannot do is forge the header that says who it asked for.
    // The bare authority is accepted only on port 80, where a client is obliged
    // to omit the port; on any other port it did not come from this server.
    for (const host of ['evil.com', `127.0.0.1:${server.port}.evil.com`, 'example.com:80', '127.0.0.1', 'localhost']) {
      assert.equal((await request(server, '/', { host })).status, 403, `Host: ${host}`);
    }
    for (const origin of ['http://evil.com', 'null', `https://127.0.0.1:${server.port}`]) {
      assert.equal((await request(server, '/', { origin })).status, 403, `Origin: ${origin}`);
    }
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await request(server, '/', { 'sec-fetch-site': site })).status, 403, `Sec-Fetch-Site: ${site}`);
    }
    // A same-origin navigation sends no Origin at all, and curl sends no fetch
    // metadata, so absent has to pass or the tool refuses its own window.
    assert.equal((await request(server, '/', { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await request(server, '/', { origin: `http://localhost:${server.port}` })).status, 200);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * The event stream
 * ------------------------------------------------------------------ */

/** Holds `/events` open the way a window does, and records the raw bytes. */
function listen(server: UiServer): { frames: () => string; end: () => void } {
  let frames = '';
  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    path: '/events',
    headers: { host: `127.0.0.1:${server.port}`, accept: 'text/event-stream' },
  });
  req.on('response', (res) => res.on('data', (chunk: Buffer) => (frames += chunk.toString('utf8'))));
  req.on('error', () => undefined);
  req.end();
  return { frames: () => frames, end: () => req.destroy() };
}

test('the stream opens with a retry interval and the current stamp', async () => {
  const stub = stubServer();
  const server = await stub.start();
  const client = listen(server);
  try {
    await sleep(150);
    // `retry` first: a window that reconnects to a server that has not come back
    // yet must not spin. The stamp lets it notice it is stale.
    assert.equal(client.frames(), 'retry: 500\n\nevent: hello\ndata: first\n\n');
    assert.equal(server.clients, 1);
  } finally {
    client.end();
    await server.close();
  }
});

test('a reload is pushed when the drawing changed, and only then', async () => {
  const stub = stubServer();
  const server = await stub.start();
  const client = listen(server);
  try {
    await sleep(150);

    assert.equal(await server.refresh(), false, 'the same page is not news');
    await sleep(100);
    assert.ok(!client.frames().includes('reload'), 'a window must not blink for nothing');

    stub.set('second');
    assert.equal(await server.refresh(), true);
    await sleep(100);
    assert.ok(client.frames().includes('event: reload\ndata: second\n\n'));
    assert.match((await request(server, '/')).body, /second/, 'and the page served after it is the new one');
  } finally {
    client.end();
    await server.close();
  }
});

test('a scan that failed is not announced as one that worked', async () => {
  const stub = stubServer();
  const server = await stub.start();
  const client = listen(server);
  try {
    await sleep(150);
    server.announce('scanning');
    server.announce('scan-failed');
    await sleep(100);

    const frames = client.frames();
    assert.ok(frames.includes('event: scanning'), 'the window says a scan started');
    assert.ok(frames.includes('event: scan-failed'), 'and says when it did not finish');
    assert.ok(!frames.includes('event: scanned'), 'a failure must not read as a success');
    // The page has to be able to act on it, or the distinction dies in the wire.
    assert.ok(renderGraphHtml(fixture(), [], { live: { stamp: 'x' } }).includes("addEventListener('scan-failed'"));
  } finally {
    client.end();
    await server.close();
  }
});

test('a window is told the server is going away before the socket does', async () => {
  const stub = stubServer();
  const server = await stub.start();
  const client = listen(server);
  await sleep(150);

  // Without this an EventSource retries a dead port every 500ms for as long as
  // the window stays open — against a port that may by then be someone else's.
  await server.close();
  await sleep(100);
  assert.ok(client.frames().includes('event: bye'), 'the goodbye flushes before close() resolves');
  assert.equal(server.clients, 0);
  client.end();
});

/* ------------------------------------------------------------------ *
 * Watching
 * ------------------------------------------------------------------ */

test('a burst of saves is one rescan', async () => {
  let calls = 0;
  const fire = debounce(40, () => calls++);
  // One writeFile is two events on Windows, and an editor that saves through a
  // temp file is more. The interesting moment is when they stop.
  for (let i = 0; i < 25; i++) fire();
  assert.equal(calls, 0, 'nothing runs while the events are still arriving');
  await sleep(120);
  assert.equal(calls, 1);

  fire();
  fire.cancel();
  await sleep(120);
  assert.equal(calls, 1, 'a cancelled debounce never fires');
});

test('two scans never run at once, and one that throws does not stop the next', async () => {
  let running = 0;
  let peak = 0;
  let runs = 0;
  let failures = 0;

  const run = serialised(
    async () => {
      running++;
      peak = Math.max(peak, running);
      runs++;
      await sleep(30);
      running--;
      if (runs === 1) throw new Error('half-edited contract');
    },
    () => failures++,
  );

  for (let i = 0; i < 6; i++) run();
  await sleep(300);

  assert.equal(peak, 1, 'a second scan must never start inside the first');
  assert.equal(runs, 2, 'a burst queues exactly one more run, not one per change');
  assert.equal(failures, 1, 'the failure is reported rather than swallowed or thrown');
});

/* ------------------------------------------------------------------ *
 * Ports, through the CLI a user actually types
 * ------------------------------------------------------------------ */

async function cli(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, '--cwd', demo, ...args], {
      // These runs are all meant to fail before anything listens. A timeout is
      // the difference between a red test and a suite that hangs forever.
      timeout: 20_000,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

test('`graph --format html` and `ui --once` write the same bytes', async () => {
  // The README says the two are md5-identical and that a test enforces it. No
  // test did. They are identical for a structural reason — neither passes a
  // render option, so neither can acquire the live client — and a structural
  // reason is exactly the kind that survives until somebody adds an argument to
  // one call site. Both commands write to the same default destination, so this
  // runs them in a scratch copy of the vault rather than in the repository.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'stellar-memory-page-'));
  try {
    mkdirSync(path.join(scratch, '.stellar-memory'));
    copyFileSync(
      path.join(demo, '.stellar-memory', 'index.json'),
      path.join(scratch, '.stellar-memory', 'index.json'),
    );
    const written = path.join(scratch, 'stellar-memory-graph.html');
    const md5 = (): string => createHash('md5').update(readFileSync(written)).digest('hex');

    const drawn = await execFileAsync(process.execPath, [entry, '--cwd', scratch, 'graph', '--format', 'html'], {
      timeout: 60_000,
    });
    const fromGraph = md5();

    await execFileAsync(process.execPath, [entry, '--cwd', scratch, 'ui', '--once', '--no-open'], { timeout: 60_000 });
    assert.equal(md5(), fromGraph, '`ui --once` writes the file `graph --format html` writes');

    // And the same command twice is the zero-line diff the vault beside it gets.
    await execFileAsync(process.execPath, [entry, '--cwd', scratch, 'graph', '--format', 'html'], { timeout: 60_000 });
    assert.equal(md5(), fromGraph, 'and a second run of either changes nothing');

    assert.ok(!(drawn.stdout + drawn.stderr).includes('EventSource'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a port that is not a port fails before anything binds', async () => {
  for (const bad of ['abc', '-1', '70000', '1.5']) {
    const run = await cli('ui', '--no-open', '--port', bad);
    assert.equal(run.code, 1, `--port ${bad} must not start a server`);
    assert.match(run.output, /whole number from 0 to 65535/);
    assert.ok(!/\n\s+at /.test(run.output), 'a sentence, not a stack trace');
  }
});

test('a port already taken is reported as such, not swapped silently', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const taken = (blocker.address() as net.AddressInfo).port;
  try {
    const run = await cli('ui', '--no-open', '--port', String(taken));
    assert.equal(run.code, 1);
    assert.match(run.output, new RegExp(`Port ${taken} is already in use`));
    // Reporting a port nobody asked for is the quiet misstatement this avoids.
    assert.ok(!run.output.includes(`http://127.0.0.1:${taken}`));
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
