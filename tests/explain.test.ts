/**
 * `explain --ai` when the model cannot be reached.
 *
 * The README advertises the flag and most people will try it before they set a
 * key, so the no-credentials run is the first thing a stranger sees of the AI
 * layer. It has to degrade: say what is missing, answer the question anyway
 * from the local index, and exit 0. A stack trace out of the SDK there reads as
 * a broken tool.
 *
 * Nothing here touches the network. Without credentials the SDK throws while
 * building the request headers, so no socket is opened — and the base URL is
 * pointed at an unroutable address so that stays true if the SDK ever changes.
 *
 * Against `src`, not `dist`: this is a property of the fallback itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { register } from 'node:module';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Cleared before anything reads them, and inherited by the child runs below, so
// a developer who does have a key gets the same result as CI, which does not.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const demo = path.join(repoRoot, 'demo', 'private-payroll');

register(pathToFileURL(path.join(here, 'src-specifiers.mjs')).href);

const { answerWithAi, AiUnavailable } = await import('../src/ai/explain.ts');
const { loadMemory } = await import('../src/store/vault.ts');

const memory = await loadMemory(demo);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The exit code is half of what is being asserted, so this runs `explain` in
 * its own process rather than calling it in this one.
 */
async function explain(
  options: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Run> {
  const entry = pathToFileURL(path.join(repoRoot, 'src', 'commands', 'explain.ts')).href;
  const script = [
    `import { register } from 'node:module';`,
    `register(${JSON.stringify(pathToFileURL(path.join(here, 'src-specifiers.mjs')).href)});`,
    `const { runExplain } = await import(${JSON.stringify(entry)});`,
    `await runExplain(JSON.parse(process.env.EXPLAIN_OPTIONS));`,
  ].join('\n');

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ...env,
          EXPLAIN_OPTIONS: JSON.stringify({ cwd: demo, ...options }),
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('a missing key is an AiUnavailable, not whatever the SDK threw', async () => {
  // The client used to be built outside the try that calls translate(), so any
  // failure raised before the request escaped as an internal SDK error and the
  // caller's `instanceof AiUnavailable` branch — the whole fallback — was dead.
  const error = await answerWithAi(memory, 'how does payment flow work?').then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof AiUnavailable, `expected AiUnavailable, got ${error}`);
  assert.match(error.message, /ANTHROPIC_API_KEY/, 'it names the thing that is missing');
  assert.doesNotMatch(
    error.message,
    /Could not resolve authentication method/,
    'and does not pass the SDK internal wording through to the user',
  );
});

test('a client that cannot even be constructed is an AiUnavailable too', async () => {
  // The credential check moved into the request between SDK versions, but the
  // constructor still throws on its own — here for the missing global `fetch`
  // that `--no-experimental-fetch` produced on the Node 20 this still supports.
  // Built outside the try, that escaped translate() and reached the user raw.
  const script = [
    `delete globalThis.fetch;`,
    `import { register } from 'node:module';`,
    `register(${JSON.stringify(pathToFileURL(path.join(here, 'src-specifiers.mjs')).href)});`,
    `const { answerWithAi, AiUnavailable } = await import(`,
    `  ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src', 'ai', 'explain.ts')).href)});`,
    `const { loadMemory } = await import(`,
    `  ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src', 'store', 'vault.ts')).href)});`,
    `const memory = await loadMemory(process.env.EXPLAIN_DEMO);`,
    `try { await answerWithAi(memory, 'what pays whom?'); process.stdout.write('NO THROW'); }`,
    `catch (e) { process.stdout.write(e instanceof AiUnavailable ? 'AiUnavailable' : 'ESCAPED'); }`,
  ].join('\n');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, EXPLAIN_DEMO: demo } },
  );

  assert.equal(stdout, 'AiUnavailable', 'every pre-flight failure has to reach the fallback');
});

test('explain --ai without credentials still answers, and exits 0', async () => {
  const run = await explain({ question: 'how does payment flow work?', ai: true });

  assert.equal(run.code, 0, 'a degraded answer is still an answer');
  assert.match(run.stderr, /ANTHROPIC_API_KEY/, 'it says what is missing');
  assert.match(run.stderr, /Falling back to deterministic search/);

  // The question still gets answered from the index, on stdout, where a
  // redirect to a file would capture it.
  assert.match(run.stdout, /Matches for "how does payment flow work\?"/);
  assert.match(run.stdout, /payroll/);

  assert.doesNotMatch(
    run.stdout + run.stderr,
    /node_modules/,
    'a stack trace would name the SDK that raised it',
  );
});

/**
 * A stub that answers like the Messages API, so the *successful* path can be
 * asserted without a key and without the network. It binds loopback on an
 * ephemeral port and is closed by the test that started it.
 */
async function withStubModel<T>(prose: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: prose }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('model prose is labelled as inferred on the stream that carries it', async () => {
  // The README promises "everything the AI produces is labelled as inferred".
  // The label used to go to stderr while the prose went to stdout, so
  // `explain --ai > notes.md` wrote a file of generated text with the
  // attribution stripped off — which is the one thing this project exists not
  // to produce. stdout alone has to carry both.
  const prose = 'Payroll pulls each salary from Treasury and records who was paid.';
  const run = await withStubModel(prose, (baseUrl) =>
    explain(
      { question: 'how does payment flow work?', ai: true },
      { ANTHROPIC_API_KEY: 'sk-ant-stub', ANTHROPIC_BASE_URL: baseUrl },
    ),
  );

  assert.equal(run.code, 0);
  assert.match(run.stdout, /Payroll pulls each salary/, 'the answer is on stdout');
  assert.match(run.stdout, /Inferred by/, 'and so is the word that says it was generated');
  assert.match(run.stdout, /claude-opus-5/, 'named, so a reader knows what produced it');
  // "from the local index" read as though the answer had been retrieved rather
  // than written, which is the opposite of the fact being disclosed.
  assert.doesNotMatch(run.stdout, /from the local index/);
});

test('the JSON answer says it was inferred too', async () => {
  const run = await withStubModel('Treasury holds the funds.', (baseUrl) =>
    explain(
      { question: 'where are funds held?', ai: true, json: true },
      { ANTHROPIC_API_KEY: 'sk-ant-stub', ANTHROPIC_BASE_URL: baseUrl },
    ),
  );

  assert.equal(run.code, 0);
  const answer = JSON.parse(run.stdout) as { text: string; model: string; inferred?: boolean };
  assert.match(answer.text, /Treasury holds the funds/);
  // A consumer parsing this has no other signal that the prose was generated.
  assert.equal(answer.inferred, true);
});

test('explain --ai --json degrades into JSON, not prose', async () => {
  // A caller that asked for JSON is parsing stdout. Falling back is not licence
  // to answer in a different format than the one that was requested.
  const run = await explain({ question: 'who can change a salary?', ai: true, json: true });

  assert.equal(run.code, 0);
  const hits = JSON.parse(run.stdout) as { id: string; kind: string }[];
  assert.ok(Array.isArray(hits) && hits.length > 0, 'and it is a non-empty result');
  assert.ok(
    hits.every((h) => typeof h.id === 'string' && typeof h.kind === 'string'),
    'in the same shape as a run that was never asked for --ai',
  );
});
