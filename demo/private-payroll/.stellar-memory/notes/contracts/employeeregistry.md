---
id: contract:EmployeeRegistry
kind: contract
title: EmployeeRegistry
path: contracts/employee-registry/src/lib.rs
summary: Soroban contract with 4 public functions.
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T15:54:59.434Z
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

**Tested by**
- [[tests/contracts/payroll/src/test.rs|payroll/test.rs]]

**Documented in**
- [[docs/readme|README.md]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/employee-registry/src/lib.rs:12`
- Reported by `stellar contract info hash --wasm target/wasm32v1-none/release/employee_registry.wasm` (ground truth)

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
