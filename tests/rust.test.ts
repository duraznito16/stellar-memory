import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseRustFile, stripComments } from '../src/scanner/rust.ts';

/**
 * A contract written the way real Soroban code is written, including the things
 * that break naive regex scanners: a `//` inside a string, a commented-out
 * storage call, a lifetime that looks like a char literal, and a nested block
 * comment.
 */
const PAYROLL = `
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, Symbol, Vec};

/// Docs mentioning storage().instance().set() should never become a fact.
/* outer /* nested */ still a comment: env.events().publish(()) */

pub const DOCS: &str = "https://example.com//payroll";

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Employee(Address),
    Treasury,
}

#[contracterror]
#[derive(Copy, Clone)]
pub enum PayrollError {
    NotAuthorized = 1,
    InsufficientFunds = 2,
}

mod treasury {
    soroban_sdk::contractimport!(file = "../treasury/treasury.wasm");
}

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    pub fn initialize(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        // env.storage().persistent().set(&DataKey::Ghost, &admin);
    }

    pub fn pay(env: Env, employee: Address, amount: i128) -> Result<(), PayrollError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let treasury_addr: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let client = treasury::Client::new(&env, &treasury_addr);
        client.withdraw(&employee, &amount);

        env.storage().persistent().set(&DataKey::Employee(employee.clone()), &amount);
        env.storage().persistent().extend_ttl(&DataKey::Employee(employee.clone()), 100, 200);

        env.events().publish((Symbol::new(&env, "paid"), employee), amount);
        Ok(())
    }

    pub fn balance_of(env: Env, employee: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Employee(employee)).unwrap_or(0)
    }

    fn internal_helper<'a>(_x: &'a str) -> char { 'y' }
}

#[cfg(test)]
mod test {
    // tests live here
}
`;

test('strips comments without eating strings', () => {
  const stripped = stripComments(PAYROLL);
  assert.ok(stripped.includes('https://example.com//payroll'), 'string literal survived');
  assert.ok(!stripped.includes('should never become a fact'), 'doc comment removed');
  assert.ok(!stripped.includes('still a comment'), 'nested block comment removed');
  assert.equal(stripped.length, PAYROLL.length, 'offsets preserved');
});

test('finds the contract and only its public interface', () => {
  const a = analyseRustFile('contracts/payroll/src/lib.rs', PAYROLL);
  assert.equal(a.contracts.length, 1);

  const payroll = a.contracts[0]!;
  assert.equal(payroll.name, 'Payroll');

  const names = payroll.functions.map((f) => f.name).sort();
  assert.deepEqual(names, ['balance_of', 'initialize', 'pay']);
});

test('reads signatures, auth and return types', () => {
  const a = analyseRustFile('lib.rs', PAYROLL);
  const fns = a.contracts[0]!.functions;

  const pay = fns.find((f) => f.name === 'pay')!;
  assert.deepEqual(pay.params, [
    { name: 'env', type: 'Env' },
    { name: 'employee', type: 'Address' },
    { name: 'amount', type: 'i128' },
  ]);
  assert.equal(pay.returns, 'Result<(), PayrollError>');
  assert.equal(pay.requiresAuth, true);

  const balance = fns.find((f) => f.name === 'balance_of')!;
  assert.equal(balance.requiresAuth, false);
  assert.equal(balance.returns, 'i128');
});

test('ignores storage calls that are commented out', () => {
  const a = analyseRustFile('lib.rs', PAYROLL);
  const init = a.contracts[0]!.functions.find((f) => f.name === 'initialize')!;
  assert.equal(init.storage.length, 2, 'only the two live writes');
  assert.ok(init.storage.every((s) => s.durability === 'instance'));
  assert.deepEqual(
    init.storage.map((s) => s.key),
    ['DataKey::Admin', 'DataKey::Treasury'],
  );
});

test('separates durability and detects ttl extension', () => {
  const a = analyseRustFile('lib.rs', PAYROLL);
  const pay = a.contracts[0]!.functions.find((f) => f.name === 'pay')!;
  const persistent = pay.storage.filter((s) => s.durability === 'persistent');
  assert.ok(persistent.some((s) => s.op === 'set'));
  assert.ok(persistent.some((s) => s.op === 'extend_ttl'), 'extend_ttl recognised');
});

test('detects cross-contract calls and the imported wasm', () => {
  const a = analyseRustFile('lib.rs', PAYROLL);
  assert.equal(a.imports.length, 1);
  assert.equal(a.imports[0]!.module, 'treasury');
  assert.equal(a.imports[0]!.wasmFile, '../treasury/treasury.wasm');

  const pay = a.contracts[0]!.functions.find((f) => f.name === 'pay')!;
  assert.deepEqual(pay.clientCalls, ['treasury']);
});

test('collects events, types and errors', () => {
  const a = analyseRustFile('lib.rs', PAYROLL);
  const pay = a.contracts[0]!.functions.find((f) => f.name === 'pay')!;
  assert.equal(pay.events.length, 1);
  // The symbol literal is the event's real name, not the whole topic tuple.
  assert.equal(pay.events[0], 'paid');

  assert.deepEqual(a.types.map((t) => t.name), ['DataKey']);
  assert.deepEqual(a.errors.map((t) => t.name), ['PayrollError']);
  assert.equal(a.isTest, true, 'file contains a #[cfg(test)] module');
});

test('resolves a key held in a local binding', () => {
  // The idiomatic Soroban shape: bind the key once, then set and extend_ttl it.
  // Without binding resolution the extend_ttl looks like it targets a different
  // key and the tool reports a missing TTL on code that has one.
  const src = `
use soroban_sdk::{contract, contractimpl, Address, Env};
#[contract]
pub struct Vault;
#[contractimpl]
impl Vault {
    pub fn fund(env: Env, token: Address, amount: i128) {
        let key = DataKey::Balance(token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
        env.storage().persistent().extend_ttl(&key, 100, 200);
    }
}
`;
  const fn = analyseRustFile('lib.rs', src).contracts[0]!.functions[0]!;
  const keys = new Set(fn.storage.map((s) => s.key));
  assert.deepEqual([...keys], ['DataKey::Balance(token)'], 'one key, clone stripped');
  assert.ok(fn.storage.some((s) => s.op === 'extend_ttl'));
});

test('collapses the same key written with and without clone()', () => {
  const src = `
use soroban_sdk::{contract, contractimpl, Address, Env};
#[contract]
pub struct Log;
#[contractimpl]
impl Log {
    pub fn touch(env: Env, who: Address) {
        env.storage().persistent().set(&DataKey::Seen(who.clone()), &1u32);
        let seen: u32 = env.storage().persistent().get(&DataKey::Seen(who)).unwrap_or(0);
    }
}
`;
  const fn = analyseRustFile('lib.rs', src).contracts[0]!.functions[0]!;
  const keys = new Set(fn.storage.map((s) => s.key));
  assert.deepEqual([...keys], ['DataKey::Seen(who)']);
});

test('recognises every TTL-extension spelling, not just extend_ttl', () => {
  // Enumerating method names meant `extend_ttl_with_limits` matched nothing, so
  // a contract that correctly extends its TTL was warned about as one that
  // never does.
  for (const method of ['extend_ttl', 'extend_ttl_with_limits', 'extend_ttl_to_max', 'bump']) {
    const src = `
use soroban_sdk::{contract, contractimpl, Env};
#[contract]
pub struct A;
#[contractimpl]
impl A {
    pub fn write(env: Env) {
        env.storage().persistent().set(&DataKey::Bal, &1i128);
        env.storage().persistent().${method}(&DataKey::Bal, 100, 5000);
    }
}
`;
    const fn = analyseRustFile('a.rs', src).contracts[0]!.functions[0]!;
    assert.ok(
      fn.storage.some((s) => s.op === 'extend_ttl' && s.key === 'DataKey::Bal'),
      `${method} must count as a TTL extension`,
    );
  }
});

test('instance TTL extension names no storage key', () => {
  // `instance().extend_ttl(threshold, extend_to)` takes ledger numbers. Reading
  // the first argument as a key produced a storage entry called "100".
  const src = `
use soroban_sdk::{contract, contractimpl, Env};
#[contract]
pub struct A;
#[contractimpl]
impl A {
    pub fn touch(env: Env) {
        env.storage().instance().set(&DataKey::Admin, &1u32);
        env.storage().instance().extend_ttl(100, 5184000);
    }
}
`;
  const fn = analyseRustFile('a.rs', src).contracts[0]!.functions[0]!;
  const ttl = fn.storage.find((s) => s.op === 'extend_ttl')!;
  assert.equal(ttl.durability, 'instance');
  assert.equal(ttl.key, undefined, 'ledger thresholds are not a key');
  assert.ok(!fn.storage.some((s) => s.key === '100'));
});

test('ignores storage methods it does not recognise', () => {
  const src = `
use soroban_sdk::{contract, contractimpl, Env};
#[contract]
pub struct A;
#[contractimpl]
impl A {
    pub fn odd(env: Env) { env.storage().persistent().some_future_method(&DataKey::X); }
}
`;
  const fn = analyseRustFile('a.rs', src).contracts[0]!.functions[0]!;
  assert.equal(fn.storage.length, 0, 'an unknown method is not evidence of a read or a write');
});

test('reads a trait-impl contract — the idiomatic Soroban token shape', () => {
  // `impl <Trait> for <Type>` filed the block under the trait, and Rust forbids
  // `pub` on trait methods, so a token contract came back with zero functions
  // and every downstream signal went silent.
  const src = `
use soroban_sdk::{contract, contractimpl, token, Address, Env};
#[contract]
pub struct MyToken;
#[contractimpl]
impl token::TokenInterface for MyToken {
    fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        env.storage().persistent().set(&DataKey::Bal(to), &amount);
    }
    fn balance(env: Env, id: Address) -> i128 { 0 }
}
`;
  const contract = analyseRustFile('t.rs', src).contracts[0]!;
  assert.equal(contract.name, 'MyToken', 'filed under the implementing type, not the trait');
  assert.deepEqual(contract.implementsTraits, ['token::TokenInterface']);
  assert.deepEqual(contract.functions.map((f) => f.name).sort(), ['balance', 'transfer']);
});

test('private helpers stay out of an inherent impl', () => {
  const src = `
use soroban_sdk::{contract, contractimpl, Env};
#[contract]
pub struct A;
#[contractimpl]
impl A {
    pub fn exposed(env: Env) {}
    fn helper(env: Env) {}
}
`;
  const contract = analyseRustFile('a.rs', src).contracts[0]!;
  assert.deepEqual(contract.functions.map((f) => f.name), ['exposed']);
});

test('distinguishes whose authority require_auth demands', () => {
  const src = `
use soroban_sdk::{contract, contractimpl, Address, Env};
#[contract]
pub struct T;
#[contractimpl]
impl T {
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }
    pub fn withdraw(env: Env, to: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Bal(to), &0i128);
    }
    pub fn sweep(env: Env) {
        env.current_contract_address().require_auth();
    }
}
`;
  const fns = analyseRustFile('u.rs', src).contracts[0]!.functions;
  const subjectOf = (name: string) => fns.find((f) => f.name === name)!.authSubjects[0]!;

  // A caller-supplied parameter restricts nobody; a stored address does.
  assert.equal(subjectOf('initialize').origin, 'param');
  assert.equal(subjectOf('withdraw').origin, 'storage');
  assert.equal(subjectOf('withdraw').key, 'DataKey::Admin');
  assert.equal(subjectOf('sweep').origin, 'current_contract');
});

test('detects an upgradeable contract and the function that does it', () => {
  const src = `
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};
#[contract]
pub struct A;
#[contractimpl]
impl A {
    pub fn bump(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
    pub fn balance(env: Env) -> i128 { 0 }
}
`;
  const contract = analyseRustFile('a.rs', src).contracts[0]!;
  assert.equal(contract.upgradeable, true);
  assert.equal(contract.upgradeFn, 'bump');
});

test('follows storage and role lookups into free helper functions', () => {
  // The official Soroban examples keep storage access in helper modules
  // (balance.rs, allowance.rs, read_admin). Walking only `#[contractimpl]`
  // bodies made the entire fund-bearing storage surface invisible, and turned
  // every helper-resolved admin into an unknown auth subject.
  const src = `
use soroban_sdk::{contract, contractimpl, Address, Env};

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}
fn write_balance(env: &Env, addr: &Address, amount: i128) {
    env.storage().persistent().set(&DataKey::Balance(addr.clone()), &amount);
    env.storage().persistent().extend_ttl(&DataKey::Balance(addr.clone()), 100, 200);
}

#[contract]
pub struct Token;
#[contractimpl]
impl Token {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        write_balance(&env, &to, amount);
    }
}
`;
  const contract = analyseRustFile('t.rs', src).contracts[0]!;
  assert.deepEqual(contract.functions.map((f) => f.name), ['mint'], 'helpers are not entry points');

  const mint = contract.functions[0]!;
  assert.equal(mint.authSubjects[0]?.origin, 'storage', 'admin resolved through the helper');
  assert.equal(mint.authSubjects[0]?.key, 'DataKey::Admin');

  // The balance write and its TTL extension both live in the helper.
  assert.ok(mint.storage.some((s) => s.op === 'set' && s.key === 'DataKey::Balance(addr)'));
  assert.ok(
    mint.storage.some((s) => s.op === 'extend_ttl' && s.key === 'DataKey::Balance(addr)'),
    'a TTL extended inside a helper still counts',
  );
});

test('a plain Rust file yields no contracts', () => {
  const a = analyseRustFile('src/util.rs', 'pub fn add(a: u32, b: u32) -> u32 { a + b }');
  assert.equal(a.contracts.length, 0);
  assert.equal(a.usesSorobanSdk, false);
});
