/**
 * The scan, run against trees shaped like the ones it will meet.
 *
 * Every fixture here is a workspace someone could have generated: two crates out
 * of `stellar contract init` (which names both structs `Contract`), a token laid
 * out the canonical way with its storage in `balance.rs`, an import written at
 * the crate root instead of inside a `mod`. Those are the shapes that broke, and
 * a smaller snippet would have passed while the repository stayed wrong.
 *
 * The offline test scans the committed demo, because the failure it guards is
 * exactly the README's `post-commit` hook: a source-only scan that deletes the
 * half of the memory it never looked at.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Against `src`: the hook exists because the source imports its siblings with
// the `.js` specifiers the compiler emits, which type stripping leaves alone.
register('./src-specifiers.mjs', import.meta.url);

const { scanProject } = await import('../src/scanner/scan.ts');
type ProjectMemory = Awaited<ReturnType<typeof scanProject>>['memory'];
type MemoryEdge = ProjectMemory['edges'][number];
type ContractData = { crate: string; functions: string[]; localWasmHash?: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, '..', 'demo', 'private-payroll');
const NOW = '2026-01-01T00:00:00.000Z';

const roots: string[] = [];

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

/** Write a workspace to a temp directory and hand back its root. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-memory-scan-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

const scan = (root: string, previous?: ProjectMemory) =>
  scanProject({ root, now: NOW, online: false, previous });

const WORKSPACE = `[workspace]
resolver = "2"
members = ["contracts/*"]
`;

const manifest = (name: string) => `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]
doctest = false

[dependencies]
soroban-sdk = "22.0.0"
`;

const edgesBetween = (edges: MemoryEdge[], from: string, to: string) =>
  edges.filter((e) => e.from === from && e.to === to);

/* ------------------------------------------------------------------ *
 * Contract identity
 * ------------------------------------------------------------------ */

// What `stellar contract init contracts/<name>` writes, in both crates: the
// struct is always called `Contract`.
const GENERATED_A = `#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Total,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let total: i128 = env.storage().instance().get(&DataKey::Total).unwrap_or(0);
        env.storage().instance().set(&DataKey::Total, &(total + amount));
        env.events().publish((symbol_short!("deposit"), from), amount);
    }
}
`;

const GENERATED_B = `#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Roster,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn register(env: Env, employee: Address) {
        let mut roster: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Roster)
            .unwrap_or(Vec::new(&env));
        roster.push_back(employee);
        env.storage().instance().set(&DataKey::Roster, &roster);
    }
}
`;

test('two crates that both declare `Contract` stay two contracts', async () => {
  // `addNode` merges on id with a shallow spread, so one id for both left a
  // single node carrying the last file's crate and path, the union of both
  // interfaces as its function list, and a `defines` edge from each crate.
  const root = await tree({
    'Cargo.toml': WORKSPACE,
    'contracts/a/Cargo.toml': manifest('a'),
    'contracts/a/src/lib.rs': GENERATED_A,
    'contracts/b/Cargo.toml': manifest('b'),
    'contracts/b/src/lib.rs': GENERATED_B,
  });

  const { memory } = await scan(root);
  const ids = new Set(memory.nodes.map((n) => n.id));

  assert.ok(ids.has('contract:a.Contract'), 'the contract in crate a');
  assert.ok(ids.has('contract:b.Contract'), 'the contract in crate b');
  assert.ok(!ids.has('contract:Contract'), 'and nothing they were merged into');

  const a = memory.nodes.find((n) => n.id === 'contract:a.Contract')!;
  const b = memory.nodes.find((n) => n.id === 'contract:b.Contract')!;
  assert.equal((a.data as unknown as ContractData).crate, 'a');
  assert.equal((b.data as unknown as ContractData).crate, 'b');
  assert.equal(a.path, 'contracts/a/src/lib.rs');
  assert.equal(b.path, 'contracts/b/src/lib.rs');
  assert.deepEqual((a.data as unknown as ContractData).functions, ['__constructor', 'deposit']);
  assert.deepEqual((b.data as unknown as ContractData).functions, ['register']);

  assert.equal(edgesBetween(memory.edges, 'crate:a', 'contract:a.Contract').length, 1);
  assert.equal(edgesBetween(memory.edges, 'crate:b', 'contract:b.Contract').length, 1);
  assert.equal(
    edgesBetween(memory.edges, 'crate:a', 'contract:b.Contract').length,
    0,
    'a crate defines its own contract and no other',
  );

  assert.ok(ids.has('function:a.Contract.deposit'));
  assert.ok(ids.has('function:b.Contract.register'));
  assert.ok(
    ids.has('storage:a.Contract.instance.DataKey::Total') &&
      ids.has('storage:b.Contract.instance.DataKey::Roster'),
    'two contracts do not share a storage entry because their structs share a name',
  );
  assert.ok(
    !memory.edges.some((e) => e.from.startsWith('function:a.') && e.to.startsWith('storage:b.')),
    'and no function reaches into the other crate’s state',
  );
});

test('a contract only one crate declares keeps the id its vault already links to', async () => {
  // An id is a note's file name and the target of every wikilink to it.
  // Qualifying unconditionally would rename every note in every existing vault
  // and reset the firstSeen it had accumulated, so the crate is only added
  // where a second crate claims the same name.
  const root = await tree({
    'Cargo.toml': WORKSPACE,
    'contracts/payroll/Cargo.toml': manifest('payroll'),
    'contracts/payroll/src/lib.rs': GENERATED_A.replace(/\bContract\b/g, 'Payroll'),
  });

  const { memory } = await scan(root);
  const ids = new Set(memory.nodes.map((n) => n.id));

  assert.ok(ids.has('contract:Payroll'), 'unqualified, as it was before');
  assert.ok(ids.has('function:Payroll.deposit'));
  assert.ok(ids.has('storage:Payroll.instance.DataKey::Total'));
  assert.ok(!ids.has('contract:payroll.Payroll'));
});

/* ------------------------------------------------------------------ *
 * Imports
 * ------------------------------------------------------------------ */

test('an import with no module around it invents no dependency', async () => {
  // `contractimport!` at the crate root has no `mod` to name it, so the module
  // was the empty string — and the empty string, with the `Contract` suffix the
  // resolver tries, matched whatever crate `stellar contract init` had named
  // `Contract`. Every contract in the file was then given a `calls` edge to it,
  // noted "imports undefined": an architectural claim with nothing behind it.
  const payroll = `#![no_std]
use soroban_sdk::{contract, contractimpl, contractimport, Address, Env};

// The token this payroll pays in is built elsewhere and vendored as a Wasm.
contractimport!(file = "../../wasm/soroban_token_contract.wasm");

mod registry {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/employee_registry.wasm"
    );
}

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    pub fn pay(env: Env, employee: Address, amount: i128) {
        let registry_id: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
        let client = registry::Client::new(&env, &registry_id);
        client.salary_of(&employee);
        env.storage().persistent().set(&DataKey::LastPaid(employee), &amount);
    }
}
`;

  const registry = `#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct EmployeeRegistry;

#[contractimpl]
impl EmployeeRegistry {
    pub fn salary_of(env: Env, employee: Address) -> i128 {
        env.storage().persistent().get(&employee).unwrap_or(0)
    }
}
`;

  const root = await tree({
    'Cargo.toml': WORKSPACE,
    'contracts/payroll/Cargo.toml': manifest('payroll'),
    'contracts/payroll/src/lib.rs': payroll,
    'contracts/token/Cargo.toml': manifest('token'),
    // Generated by `stellar contract init contracts/token`, struct and all.
    'contracts/token/src/lib.rs': GENERATED_A,
    'contracts/employee-registry/Cargo.toml': manifest('employee-registry'),
    'contracts/employee-registry/src/lib.rs': registry,
  });

  const { memory } = await scan(root);

  assert.deepEqual(
    edgesBetween(memory.edges, 'contract:Payroll', 'contract:Contract'),
    [],
    'the vendored Wasm names no crate here, so there is no edge to draw',
  );

  // The route that does resolve still resolves: the module name is unrelated to
  // the contract, and the imported artifact is what links it back to the crate.
  const called = memory.edges.filter(
    (e) => e.from === 'contract:Payroll' && e.kind === 'calls' && e.to.startsWith('contract:'),
  );
  assert.deepEqual(
    [...new Set(called.map((e) => e.to))],
    ['contract:EmployeeRegistry'],
    'a wrapped import naming a real artifact links, and nothing else does',
  );
});

/* ------------------------------------------------------------------ *
 * Where a fact was read
 * ------------------------------------------------------------------ */

test('a storage access folded in from a helper cites the helper’s file', async () => {
  // Provenance is how a reader checks a fact this tool presents as checked.
  // `balance.rs:87` folded into a 30-line `lib.rs` was reported as `lib.rs:87`,
  // a line that does not exist, in the graph, the CLI and the MCP alike.
  const lib = `#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

mod balance;

use crate::balance::{read_balance, write_balance};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Balance(Address),
}

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, id)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        to.require_auth();
        write_balance(&env, to, amount);
    }
}
`;

  const balance = `use soroban_sdk::{Address, Env};

use crate::DataKey;

/// Balances live here rather than in \`lib.rs\`, which is how the official token
/// example is laid out: \`admin.rs\`, \`allowance.rs\`, \`balance.rs\`, and an entry
/// point that is a single call into one of them.
///
/// The padding below is deliberate. These helpers sit further down the file than
/// \`lib.rs\` is long, so a line number attributed to the wrong file points at
/// nothing at all rather than at merely the wrong statement.
///
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
/// (line)
pub fn read_balance(e: &Env, addr: Address) -> i128 {
    e.storage().persistent().get(&DataKey::Balance(addr)).unwrap_or(0)
}

pub fn write_balance(e: &Env, addr: Address, amount: i128) {
    e.storage().persistent().set(&DataKey::Balance(addr), &amount);
}
`;

  const root = await tree({
    'Cargo.toml': WORKSPACE,
    'contracts/token/Cargo.toml': manifest('token'),
    'contracts/token/src/lib.rs': lib,
    'contracts/token/src/balance.rs': balance,
  });

  const { memory } = await scan(root);

  const rel = 'contracts/token/src/balance.rs';
  const readLine = balance.split('\n').findIndex((l) => l.includes('.get(&DataKey::Balance')) + 1;
  const writeLine = balance.split('\n').findIndex((l) => l.includes('.set(&DataKey::Balance')) + 1;
  assert.ok(readLine > lib.split('\n').length, 'the fixture only proves anything past the end of lib.rs');

  const node = memory.nodes.find((n) => n.id === 'storage:Token.persistent.DataKey::Balance(addr)');
  assert.ok(node, 'the helper’s storage is the contract’s storage');
  assert.equal(node.path, rel);
  assert.equal(node.line, readLine);
  assert.deepEqual(node.provenance[0], { source: 'source', file: rel, line: readLine });

  const read = memory.edges.find((e) => e.from === 'function:Token.balance' && e.kind === 'reads');
  const write = memory.edges.find((e) => e.from === 'function:Token.mint' && e.kind === 'writes');
  assert.deepEqual(read?.provenance[0], { source: 'source', file: rel, line: readLine });
  assert.deepEqual(write?.provenance[0], { source: 'source', file: rel, line: writeLine });
});

/* ------------------------------------------------------------------ *
 * What an edge is
 * ------------------------------------------------------------------ */

test('two storage operations on one key are two edges, not the first one twice', async () => {
  // The operator lives in the note, and `guardsOf()` in core/query.ts finds the
  // re-initialization guard by looking for the `reads` edge noted `has`. Keeping
  // only the first edge for a (from, to, kind) triple threw that away whenever
  // the key was read before it was checked, and `signals()` then reported a
  // correctly guarded initializer as one that writes state with no authorization.
  const lib = `#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Roster,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    AlreadyInitialized = 1,
}

#[contract]
pub struct EmployeeRegistry;

#[contractimpl]
impl EmployeeRegistry {
    /// One-shot: at deploy time there is no admin yet to authorize against, so
    /// the guard below is what makes a second call impossible.
    pub fn initialize(env: Env, admin: Address, employees: Vec<Address>) {
        // Read first, so the event says how large a roster the redeploy would
        // have overwritten; the check is what refuses to overwrite it.
        let existing: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Roster)
            .unwrap_or(Vec::new(&env));
        if env.storage().instance().has(&DataKey::Roster) {
            panic_with_error!(&env, RegistryError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Roster, &employees);
        env.storage().instance().set(&DataKey::Admin, &admin);
        let _ = existing;
    }

    pub fn replace_roster(env: Env, employees: Vec<Address>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Roster, &Vec::new(&env));
        env.storage().instance().set(&DataKey::Roster, &employees);
    }
}
`;

  const root = await tree({
    'Cargo.toml': WORKSPACE,
    'contracts/employee-registry/Cargo.toml': manifest('employee-registry'),
    'contracts/employee-registry/src/lib.rs': lib,
  });

  const { memory } = await scan(root);

  const roster = 'storage:EmployeeRegistry.instance.DataKey::Roster';
  const guarding = edgesBetween(memory.edges, 'function:EmployeeRegistry.initialize', roster);
  assert.deepEqual(
    guarding.filter((e) => e.kind === 'reads').map((e) => e.note).sort(),
    ['`get`', '`has`'],
    'the guard survives the read that precedes it',
  );

  assert.equal(
    edgesBetween(memory.edges, 'function:EmployeeRegistry.replace_roster', roster).filter(
      (e) => e.kind === 'writes',
    ).length,
    1,
    'the same operation on the same key twice is still one edge',
  );
});

/* ------------------------------------------------------------------ *
 * What `--offline` is allowed to forget
 * ------------------------------------------------------------------ */

test('a source-only scan keeps the on-chain half it never looked at', async () => {
  // The README installs `scan --offline` as a post-commit hook. Rebuilding
  // `nodes` from source alone deleted every deployment on every commit, took
  // `check --fail-on drift` from exit 1 to exit 0 in silence, and marked every
  // contract as changed for a change nobody made.
  const previous = JSON.parse(
    await fs.readFile(path.join(demo, '.stellar-memory', 'index.json'), 'utf8'),
  ) as ProjectMemory;

  const before = previous.nodes.filter((n) => n.kind === 'deployment');
  assert.ok(before.length > 0, 'the committed demo vault has deployments, or this proves nothing');

  const { memory } = await scan(demo, previous);

  const after = memory.nodes.filter((n) => n.kind === 'deployment');
  assert.deepEqual(
    after.map((n) => n.id).sort(),
    before.map((n) => n.id).sort(),
    'a fact that could not be refreshed is not a fact that disappeared',
  );
  assert.deepEqual(
    after.map((n) => (n.data as { drift?: string }).drift).sort(),
    before.map((n) => (n.data as { drift?: string }).drift).sort(),
    'including the drift the gate reads',
  );
  assert.equal(
    memory.edges.filter((e) => e.kind === 'deployed_as').length,
    previous.edges.filter((e) => e.kind === 'deployed_as').length,
    'a carried deployment is still attached to the contract it belongs to',
  );

  const carriedHashes = memory.nodes.filter(
    (n) => n.kind === 'contract' && (n.data as unknown as ContractData).localWasmHash,
  );
  assert.equal(
    carriedHashes.length,
    previous.nodes.filter(
      (n) => n.kind === 'contract' && (n.data as unknown as ContractData).localWasmHash,
    ).length,
    'the local Wasm hash is read by the CLI too, and is not in the source either',
  );

  const changed = memory.scans[memory.scans.length - 1]?.changed ?? [];
  assert.deepEqual(
    changed.filter((id) => id.startsWith('removed:') || id.startsWith('deployment:')),
    [],
    'nothing about a deployment moved, so nothing about one is reported',
  );
  assert.deepEqual(
    changed.filter((id) => id.startsWith('contract:') || id.startsWith('error:')),
    [],
    'and a carried field does not make its node look edited',
  );

  for (const node of after) {
    const old = before.find((n) => n.id === node.id)!;
    assert.equal(node.firstSeen, old.firstSeen);
    assert.equal(node.lastChanged, old.lastChanged);
  }

  // The demo is also the compatibility case: these ids are what the committed
  // vault's notes are named after and what its wikilinks point at.
  const ids = new Set(memory.nodes.map((n) => n.id));
  for (const id of ['contract:Payroll', 'contract:Treasury', 'function:Payroll.pay']) {
    assert.ok(ids.has(id), `${id} is the id the committed vault already uses`);
  }
});
