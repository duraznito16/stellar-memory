---
id: contract:Treasury
kind: contract
title: Treasury
path: contracts/treasury/src/lib.rs
summary: Soroban contract with 5 public functions.
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T03:43:28.401Z
tags:
  - stellar-memory
  - kind/contract
---

<!-- stellar-memory:auto -->
# Treasury

Soroban contract with 5 public functions.

**Source:** `contracts/treasury/src/lib.rs:24`

## Interface

- `initialize(env: Env, admin: Address, payroll: Address)`  🔒 requires auth — [[functions/treasury.initialize|initialize]]
- `fund(env: Env, token: Address, amount: i128) -> Result<i128, TreasuryError>`  🔒 requires auth — [[functions/treasury.fund|fund]]
- `withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<i128, TreasuryError>`  🔒 requires auth — [[functions/treasury.withdraw|withdraw]]
- `balance(env: Env, token: Address) -> i128` — [[functions/treasury.balance|balance]]
- `payroll_address(env: Env) -> Result<Address, TreasuryError>` — [[functions/treasury.payroll_address|payroll_address]]

**Local Wasm hash:** `cb696a5f0f15c833d6b2f4b9a148dfd91b5eccb82bef0236ad83dd27b6305746`

## Connections

**Deployed as**
- [[deployments/testnet.cdnr3wxjiy7gczgy6kkfuw3bv3h5k654y4iipd4zwurhngkfhhyare4r|treasury @ testnet]] — deployed build is older than source

**Defined in**
- [[crates/treasury|treasury]]
- [[private-payroll|private-payroll]]

**Called by**
- [[contracts/payroll|Payroll]] — via `treasury::Client` in `pay`

**Tested by**
- [[tests/contracts/payroll/src/test.rs|payroll/test.rs]]
- [[tests/contracts/treasury/src/test.rs|treasury/test.rs]]

**Documented in**
- [[docs/readme|README.md]]

**Mentioned in**
- [[tasks/contracts/payroll/src/test.rs-23|pay() needs an end-to-end test with a real Treasury and]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:24`
- Reported by `stellar contract info hash --wasm target/wasm32v1-none/release/treasury.wasm` (ground truth)

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
