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
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
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

test('both pages carry a content security policy', () => {
  // The header `ui` sends only protects the served copy. The written file is
  // opened over file://, where a policy has to travel inside the document.
  for (const html of [renderGraphHtml(fixture(), []), renderGraphHtml(fixture(), [], { live: { stamp: 'x' } })]) {
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  }
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

/* ------------------------------------------------------------------ *
 * The findings panel says what it shows
 * ------------------------------------------------------------------ */

test('the findings heading counts the rows printed beneath it', () => {
  const mixed: Signal[] = [
    { severity: 'warn', category: 'ttl', message: 'a persistent key is never extended', nodeId: 'contract:Payroll' },
    { severity: 'info', category: 'tests', message: 'No tests reference Payroll.', nodeId: 'contract:Payroll' },
    { severity: 'warn', category: 'tests', message: 'mock_all_auths everywhere', scope: 'project' },
  ];
  const html = renderGraphHtml(fixture(), mixed, { live: { stamp: 'x' } });

  const heading = html.match(/Worth knowing <span class="count">(\d+)<\/span>/);
  const rows = (html.match(/<button type="button" class="finding /g) ?? []).length;
  assert.equal(rows, mixed.length, 'every finding is listed');
  assert.equal(Number(heading?.[1]), rows, 'the number and the list describe the same set');
});

test('a project-wide finding appears in the file that has no findings list', () => {
  // It carries no nodeId, so it draws no ring and fills no table row. Counting
  // it in the header and then showing it nowhere is the failure this whole tool
  // exists to avoid.
  const wide: Signal[] = [
    { severity: 'warn', category: 'tests', message: 'Every test module calls mock_all_auths.', scope: 'project' },
  ];
  const file = renderGraphHtml(fixture(), wide);

  assert.match(file, /stat--warn"><b>1<\/b>/, 'the header counts it');
  assert.ok(file.includes('Every test module calls mock_all_auths.'), 'and the page can substantiate the count');
  assert.ok(
    !renderGraphHtml(fixture(), []).includes('<section class="project-findings">'),
    'and the block is absent when there is nothing project-wide to put in it',
  );
});

test('the demo renders the same finding count it can show', () => {
  // The real vault, in the shape a reader will see it: every warning the header
  // claims has either a ring on the graph or a line in the project block.
  const memory = JSON.parse(
    readFileSync(path.join(demo, '.stellar-memory', 'index.json'), 'utf8'),
  ) as ProjectMemory;
  const found = signals(memory);
  const html = renderGraphHtml(memory, found);

  const claimed = Number(html.match(/stat--warn"><b>(\d+)<\/b>/)?.[1]);
  const rings = (html.match(/class="ring ring--warn"/g) ?? []).length;
  const wide = (html.match(/class="finding finding--warn"/g) ?? []).length;
  assert.equal(claimed, found.filter((s) => s.severity === 'warn').length);
  assert.equal(rings + wide, claimed, 'every warning the header counts is visible somewhere on the page');
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
