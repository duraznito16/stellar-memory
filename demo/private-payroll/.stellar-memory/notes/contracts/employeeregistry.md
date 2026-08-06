---
id: contract:EmployeeRegistry
kind: contract
title: EmployeeRegistry
path: contracts/employee-registry/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/contract
---

<!-- stellar-memory:auto -->
# EmployeeRegistry

Soroban contract with 4 public functions.

**Source:** `contracts/employee-registry/src/lib.rs:12`

## Interface

- `initialize(env: Env, admin: Address)`  🔒 requires auth — [[functions/employeeregistry.initialize|initialize]]
- `set_salary(env: Env, employee: Address, amount: i128)`  🔒 requires auth — [[functions/employeeregistry.set_salary|set_salary]]
- `remove(env: Env, employee: Address)`  🔒 requires auth — [[functions/employeeregistry.remove|remove]]
- `salary_of(env: Env, employee: Address) -> i128` — [[functions/employeeregistry.salary_of|salary_of]]

**Local Wasm hash:** `92065fb36f832750f5b6b1144e1731ef6fab5e47e80009c7bb6742fc3c3c497b`

## Connections

**Deployed as**
- [[deployments/testnet.ca2uqyd63jwh5mxvemtpiweqz2eq7dlbumzrowtkbn5uflycl7o2twrn|employee-registry @ testnet]]

**Defined in**
- [[crates/employee-registry|employee-registry]]
- [[private-payroll|private-payroll]]

**Called by**
- [[contracts/payroll|Payroll]] — via `registry::Client` in `pay`
- [[functions/payroll.pay|pay]] — calls `salary_of` — address from `DataKey::Registry`

**Tested by**
- [[tests/contracts/payroll/src/test.rs|payroll/test.rs]]

**Documented in**
- [[docs/readme|README.md]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/employee-registry/src/lib.rs:12`
- Read from `target/wasm32v1-none/release/employee_registry.wasm`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
