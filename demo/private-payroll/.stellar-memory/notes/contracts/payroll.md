---
id: contract:Payroll
kind: contract
title: Payroll
path: contracts/payroll/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T21:43:06.877Z
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

**Local Wasm hash:** `7f0be93b08d2507d2357e6bcf4940b8aa82ca03befe47338c85193a58cd3263c`

## Connections

**Calls**
- [[contracts/employeeregistry|EmployeeRegistry]] — via `registry::Client` in `pay`
- [[contracts/treasury|Treasury]] — via `treasury::Client` in `pay`

**Deployed as**
- [[deployments/testnet.cdvmjuz4yzig6jme7lgvew6mpntv5dkr6vcazlnradinpldvhlb4z7xu|payroll @ testnet]] — deployed build is older than source

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
- Read from `target/wasm32v1-none/release/payroll.wasm`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
