---
id: contract:Payroll
kind: contract
title: Payroll
path: demo/private-payroll/contracts/payroll/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-06T18:12:12.243Z
last_changed: 2026-08-06T18:12:12.243Z
tags:
  - stellar-memory
  - kind/contract
---

<!-- stellar-memory:auto -->
# Payroll

Soroban contract with 4 public functions.

**Source:** `demo/private-payroll/contracts/payroll/src/lib.rs:38`

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
- [[semillero|Semillero]]

**Tested by**
- [[tests/demo/private-payroll/contracts/payroll/src/test.rs|payroll/test.rs]]

**Documented in**
- [[docs/.claude/agents/memory-vault|memory-vault.md]]
- [[docs/.claude/agents/release-verify|release-verify.md]]
- [[docs/demo/private-payroll/readme|README.md]]
- [[docs/docs/roadmap|ROADMAP.md]]
- [[docs/readme|README.md]]
- [[docs/templates/agents/stellar-explorer|stellar-explorer.md]]

**Mentioned in**
- [[tasks/demo/private-payroll/contracts/payroll/src/lib.rs-103|missing require_auth — anyone can repoint payroll at a worthless token.]]
- [[tasks/demo/private-payroll/readme.md-24|Complete withdrawal tests for Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:38`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
