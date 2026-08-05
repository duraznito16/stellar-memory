---
id: contract:Payroll
kind: contract
title: Payroll
path: contracts/payroll/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T15:54:59.434Z
tags:
  - stellar-memory
  - kind/contract
---

<!-- stellar-memory:auto -->
# Payroll

Soroban contract with 4 public functions.

**Source:** `contracts/payroll/src/lib.rs:38`

## Interface

- `initialize(env: Env, admin: Address, treasury_id: Address, registry_id: Address, pay_token: Address)`  🔒 requires auth — [[functions/payroll.initialize|initialize]]
- `pay(env: Env, employee: Address) -> Result<i128, PayrollError>`  🔒 requires auth — [[functions/payroll.pay|pay]]
- `set_pay_token(env: Env, token: Address)` — [[functions/payroll.set_pay_token|set_pay_token]]
- `last_paid(env: Env, employee: Address) -> u32` — [[functions/payroll.last_paid|last_paid]]

**Local Wasm hash:** `827959b533719d77c85ce78d4292459a4a1009bc6838125006c370ff0dd5b63c`

## Connections

**Calls**
- [[contracts/employeeregistry|EmployeeRegistry]] — via `registry::Client` in `pay`
- [[contracts/treasury|Treasury]] — via `treasury::Client` in `pay`

**Deployed as**
- [[deployments/testnet.cdvmjuz4yzig6jme7lgvew6mpntv5dkr6vcazlnradinpldvhlb4z7xu|payroll @ testnet]]

**Defined in**
- [[crates/payroll|payroll]]
- [[private-payroll|private-payroll]]

**Tested by**
- [[tests/contracts/payroll/src/test.rs|payroll/test.rs]]

**Documented in**
- [[docs/readme|README.md]]

**Mentioned in**
- [[tasks/contracts/payroll/src/lib.rs-103|missing require_auth — anyone can repoint payroll at a worthless token.]]
- [[tasks/readme.md-24|Complete withdrawal tests for Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:38`
- Reported by `stellar contract info hash --wasm target/wasm32v1-none/release/payroll.wasm` (ground truth)

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
