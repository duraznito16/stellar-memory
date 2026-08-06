/**
 * The one promise the vault makes: "Anything you write here is yours. It is
 * never overwritten."
 *
 * Everything else in a note can be rebuilt by rescanning. The prose cannot, and
 * neither can the frontmatter someone added by hand to make Obsidian behave.
 * Each test here is one way that text was found to disappear — a second node
 * landing on the same file, a scan interrupted halfway through a write, a
 * marker quoted out of a README, a hand-written header, a byte order mark left
 * by Notepad — and none of them announced itself when it happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Against `src`, not `dist`: these are file-format guarantees, and a test that
// only runs after a build is a test that stops being run. The hook exists
// because the source imports its siblings with the `.js` specifiers the
// compiler emits, which Node's type stripping does not rewrite.
register('./src-specifiers.mjs', import.meta.url);

const { mergeNote, parseNote, serialiseNote } = await import('../src/store/note.ts');
const { noteKey, registerNoteKeys, wikilink } = await import('../src/store/keys.ts');
const { loadMemory, notePath, saveIndex, saveMemory, saveNotes, writeFileAtomic } = await import(
  '../src/store/vault.ts'
);

type Memory = Awaited<ReturnType<typeof loadMemory>>;
type Node = Memory['nodes'][number];

const AUTO_OPEN = '<!-- stellar-memory:auto -->';
const AUTO_CLOSE = '<!-- /stellar-memory:auto -->';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-vault-'));
}

function node(id: string, kind: Node['kind'], extra: Partial<Node> = {}): Node {
  return {
    id,
    kind,
    title: id.slice(id.indexOf(':') + 1),
    firstSeen: '2026-01-01',
    lastChanged: '2026-01-01',
    provenance: [{ source: 'source', file: 'src/lib.rs' }],
    ...extra,
  } as Node;
}

function memory(root: string, nodes: Node[]): Memory {
  return {
    version: 1,
    project: { name: 'test', root, networks: [] },
    nodes,
    edges: [],
    scans: [],
  } as unknown as Memory;
}

test('two ids that slug alike get a file each, and their prose stays put', async () => {
  const root = await tempDir();
  // Two real docs in one repo. On Windows and macOS the file system cannot tell
  // these apart by case, so the note names have to.
  const nodes = [node('doc:docs/Design.md', 'doc'), node('doc:docs/design.md', 'doc')];
  const mem = memory(root, nodes);

  const first = await saveNotes(mem);
  assert.equal(first.written, 2);

  const paths = nodes.map((n) => notePath(root, n));
  assert.notEqual(paths[0], paths[1], 'two nodes must not share one file');
  assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, 2);

  // A vault whose links do not open is not navigable, so the name a note is
  // written under and the name the renderer links to are the same name.
  for (const n of nodes) {
    const link = wikilink(n);
    const target = link.slice(2, link.indexOf('|'));
    await fs.access(path.join(root, '.stellar-memory', 'notes', `${target}.md`));
  }

  // The developer writes in one of them; the next scan must not move that text
  // into the other node's note or drop it.
  const mine = paths[0]!;
  const written = await fs.readFile(mine, 'utf8');
  await fs.writeFile(mine, `${written}\nRotated keys here in March. Do not undo.\n`, 'utf8');

  await saveNotes(mem);

  const after = await fs.readFile(mine, 'utf8');
  assert.match(after, /Rotated keys here in March/);
  assert.match(parseNote(after).frontmatter.id as string, /^doc:docs\/Design\.md$/);

  const other = await fs.readFile(paths[1]!, 'utf8');
  assert.doesNotMatch(other, /Rotated keys here in March/, 'prose must not migrate between nodes');
  assert.equal(parseNote(other).frontmatter.id, 'doc:docs/design.md');
});

test('names with no ASCII in them do not all collapse onto one file', () => {
  const nodes = [node('doc:文档.md', 'doc'), node('doc:说明.md', 'doc'), node('doc:仕様.md', 'doc')];
  registerNoteKeys(nodes);
  const keys = nodes.map((n) => noteKey(n));
  assert.equal(new Set(keys).size, 3, keys.join(' '));
});

test('note keys are the same on every run, and stable when the set grows', () => {
  const design = node('doc:docs/Design.md', 'doc');
  const lower = node('doc:docs/design.md', 'doc');
  const payroll = node('contract:Payroll', 'contract');

  registerNoteKeys([design, lower, payroll]);
  const first = [noteKey(design), noteKey(lower), noteKey(payroll)];

  // Same set, opposite order: a file name that depends on scan order is a diff
  // in git that means nothing.
  registerNoteKeys([payroll, lower, design]);
  assert.deepEqual([noteKey(design), noteKey(lower), noteKey(payroll)], first);

  // A node that never collided keeps the name it always had.
  assert.equal(first[2], 'contracts/payroll');
  registerNoteKeys([payroll]);
  assert.equal(noteKey(payroll), 'contracts/payroll');
});

test('a write is never seen half-finished at its destination', async () => {
  const root = await tempDir();
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'first\n', 'utf8');
  const before = await fs.stat(file);

  await writeFileAtomic(file, 'second\n');
  const after = await fs.stat(file);

  assert.equal(await fs.readFile(file, 'utf8'), 'second\n');
  // Renaming over the destination replaces the file; truncating and rewriting it
  // in place — the thing a Ctrl+C catches halfway — would keep the same one.
  assert.notEqual(after.ino, before.ino, 'the destination must be replaced, not rewritten');
  assert.deepEqual(
    (await fs.readdir(root)).filter((f) => f !== 'note.md'),
    [],
    'no temporary file may be left behind',
  );
});

test('a scan that dies writing the index has already written the notes', async () => {
  const root = await tempDir();
  const payroll = node('contract:Payroll', 'contract');
  await saveMemory(memory(root, [payroll]));

  const file = notePath(root, payroll);
  const kept = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${kept}\nPaid quarterly, deliberately.\n`, 'utf8');

  // A directory where index.json goes: as close as a test gets to the disk
  // giving up halfway through a scan.
  const index = path.join(root, '.stellar-memory', 'index.json');
  await fs.rm(index);
  await fs.mkdir(index);

  const treasury = node('contract:Treasury', 'contract');
  await assert.rejects(saveMemory(memory(root, [payroll, treasury])));

  // An index lagging behind the notes is caught up by the next scan. The other
  // order leaves it announcing a node whose note was never written, and every
  // reader of the vault believes the index.
  await fs.access(notePath(root, treasury));
  assert.match(await fs.readFile(file, 'utf8'), /Paid quarterly, deliberately/);
  assert.deepEqual(
    (await fs.readdir(path.join(root, '.stellar-memory', 'notes', 'contracts'))).sort(),
    ['payroll.md', 'treasury.md'],
    'no temporary file may be left behind in the vault',
  );
});

test('the index is replaced whole, never rewritten in place', async () => {
  const root = await tempDir();
  const mem = memory(root, [node('contract:Payroll', 'contract')]);
  await saveIndex(mem);
  const file = path.join(root, '.stellar-memory', 'index.json');
  const before = await fs.stat(file);

  mem.nodes.push(node('contract:Treasury', 'contract'));
  await saveIndex(mem);

  // Truncated in place, an interrupted write leaves JSON that ends mid-object,
  // and the vault stops loading at all.
  assert.notEqual((await fs.stat(file)).ino, before.ino);
  assert.equal((await loadMemory(root)).nodes.length, 2);
  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a closing marker quoted from the project cannot end the block', async () => {
  // A README that documents this very format, scanned into a summary.
  const auto = `Summary: wrap it in ${AUTO_CLOSE} to close.\n\n## Links\n\n- [[contracts/payroll|Payroll]]`;
  const note = mergeNote(null, { id: 'doc:readme.md' }, auto);

  const parsed = parseNote(note);
  assert.match(parsed.human, /^## Notes/, 'the block must end where we put its marker');
  assert.match(parsed.auto, /## Links/, 'everything generated stays inside the block');
  assert.equal(note.split(AUTO_CLOSE).length - 1, 1, 'only one closing marker in the file');

  // And it stays that way: the failure was a note that grew a copy of its own
  // tail on every scan.
  const second = mergeNote(note, { id: 'doc:readme.md' }, auto);
  const third = mergeNote(second, { id: 'doc:readme.md' }, auto);
  assert.equal(third, second);
  assert.equal(parseNote(third).human, parsed.human);
});

test('a marker in the developer’s own notes leaves their text on their side', () => {
  const human = [
    '## Notes',
    '',
    'The generated half is fenced by `<!-- stellar-memory:auto -->` and',
    '`<!-- /stellar-memory:auto -->`. Never edit between them.',
  ].join('\n');
  const note = serialiseNote({ frontmatter: { id: 'doc:format.md' }, auto: 'Generated.', human });

  const parsed = parseNote(note);
  assert.equal(parsed.auto, 'Generated.');
  assert.equal(parsed.human, human);

  // Their markers are above the block this time, which is what nesting looks
  // like from the parser's side.
  const inverted = `${human}\n\n${AUTO_OPEN}\nGenerated.\n${AUTO_CLOSE}\n`;
  const reparsed = parseNote(inverted);
  assert.equal(reparsed.auto, 'Generated.');
  assert.equal(reparsed.human, human);
});

test('frontmatter added by hand survives a rescan; ours wins where they meet', () => {
  const generated = {
    id: 'contract:Payroll',
    kind: 'contract',
    title: 'Payroll',
    tags: ['stellar-memory', 'kind/contract'],
  };
  const first = mergeNote(null, generated, 'Generated.');

  const edited = first.replace(
    'id: contract:Payroll',
    ['aliases:', '  - Payroll v2', 'cssclasses: wide', 'id: wrong-on-purpose'].join('\n'),
  );
  const merged = parseNote(mergeNote(edited, generated, 'Generated.'));

  assert.deepEqual(merged.frontmatter.aliases, ['Payroll v2']);
  assert.equal(merged.frontmatter.cssclasses, 'wide');
  assert.equal(merged.frontmatter.id, 'contract:Payroll', 'identity is ours to write');
});

test('a tag someone added by hand is not dropped by the next scan', () => {
  const generated = { id: 'contract:Payroll', tags: ['stellar-memory', 'kind/contract'] };
  const note = mergeNote(null, generated, 'Generated.');
  const edited = note.replace('  - kind/contract', '  - kind/contract\n  - audit/2026');

  const merged = parseNote(mergeNote(edited, generated, 'Generated.'));
  assert.deepEqual(merged.frontmatter.tags, ['stellar-memory', 'kind/contract', 'audit/2026']);
});

test('a fact we stopped emitting does not linger in the header', () => {
  const before = mergeNote(
    null,
    { id: 'contract:Payroll', path: 'contracts/payroll/src/lib.rs', stale: true },
    'Generated.',
  );
  const after = parseNote(mergeNote(before, { id: 'contract:Payroll' }, 'Generated.'));

  assert.equal(after.frontmatter.path, undefined, 'a path we no longer see must not be claimed');
  assert.equal(after.frontmatter.stale, undefined, 'a node that came back is not stale');
});

test('a note saved with a BOM is still recognised as ours and marked stale', async () => {
  const root = await tempDir();
  const gone = node('contract:Retired', 'contract');
  await saveNotes(memory(root, [gone]));

  const file = notePath(root, gone);
  const raw = await fs.readFile(file, 'utf8');
  // Byte order mark and CRLF: what Notepad, or `>` in PowerShell 5.1, writes
  // back after someone adds a line to a note.
  const edited = `${raw}Kept the multisig threshold at 3 of 5.\n`.replace(/\n/g, '\r\n');
  await fs.writeFile(file, `﻿${edited}`, 'utf8');

  const result = await saveNotes(memory(root, [node('contract:Payroll', 'contract')]));
  assert.equal(result.stale, 1, 'a vanished contract must stop looking current');

  const after = await fs.readFile(file, 'utf8');
  assert.equal(parseNote(after).frontmatter.stale, true);
  assert.match(after, /Kept the multisig threshold at 3 of 5/);
});

test('a name out of a scanned repo cannot steer a note out of the vault', () => {
  const root = path.join(os.tmpdir(), 'sm-escape');
  // Crate ids carry the `name` out of a Cargo manifest verbatim, and nothing
  // has vetted it — a scan never runs cargo. Scanning someone else's repository
  // is the whole point of this tool, so the manifest is untrusted input.
  const hostile = { id: 'crate:../../elsewhere', kind: 'crate' as const };
  const ordinary = { id: 'crate:payroll', kind: 'crate' as const };
  registerNoteKeys([hostile, ordinary]);

  const notesDir = path.resolve(notePath(root, ordinary), '..', '..');
  const written = path.resolve(notePath(root, hostile));
  assert.ok(
    written.startsWith(notesDir + path.sep),
    `${written} was written outside ${notesDir}`,
  );
  // A file outside notes/ is also a file markStaleNotes will never walk again.
  assert.equal(noteKey(ordinary), 'crates/payroll', 'ordinary names are untouched');
});

test('a note never takes a name Windows reserves for a device', () => {
  // `CON.md` cannot be created on Windows at any path, with or without an
  // extension, and this is developed on Windows. A repo with a `con.rs` or a
  // doc called `AUX.md` is not hostile, just unlucky.
  const nodes = [
    { id: 'doc:CON.md', kind: 'doc' as const },
    { id: 'doc:notes/aux.md', kind: 'doc' as const },
    { id: 'doc:readme.md', kind: 'doc' as const },
  ];
  registerNoteKeys(nodes);

  for (const node of nodes.slice(0, 2)) {
    const stem = (noteKey(node).split('/').pop() ?? '').split('.')[0];
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem ?? ''), `${stem} is a device`);
  }
  assert.equal(noteKey(nodes[2]!), 'docs/readme', 'an ordinary doc keeps its plain name');
});
