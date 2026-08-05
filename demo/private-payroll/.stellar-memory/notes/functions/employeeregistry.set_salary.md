---
id: function:EmployeeRegistry.set_salary
kind: function
title: set_salary
path: contracts/employee-registry/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T02:30:56.473Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# set_salary

**Source:** `contracts/employee-registry/src/lib.rs:23`

## Signature

```rust
fn set_salary(env: Env, employee: Address, amount: i128)
```

## Authorization

- `require_auth` on `admin`, loaded from `DataKey::Admin` — this restricts callers to the stored address.

## Connections

**Reads**
- [[storage/employeeregistry.instance.datakey-admin|DataKey::Admin (instance)]] — `get`

**Writes**
- [[storage/employeeregistry.persistent.datakey-salary-employee|DataKey::Salary(employee) (persistent)]] — `set`

**Emits**
- [[events/employeeregistry.salary_set|salary_set]]

**Defined in**
- [[contracts/employeeregistry|EmployeeRegistry]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/employee-registry/src/lib.rs:23`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
