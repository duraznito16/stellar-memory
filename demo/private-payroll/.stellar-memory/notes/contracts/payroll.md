---
id: contract:Payroll
kind: contract
title: Payroll
path: contracts/payroll/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-06T02:37:04.452Z
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

## Connections

**Calls**
- [[contracts/employeeregistry|EmployeeRegistry]] — via `registry::Client` in `pay`
- [[contracts/treasury|Treasury]] — via `treasury::Client` in `pay`

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

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
