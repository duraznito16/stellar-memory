---
id: function:EmployeeRegistry.salary_of
kind: function
title: salary_of
path: demo/private-payroll/contracts/employee-registry/src/lib.rs
first_seen: 2026-08-06T05:42:08.159Z
last_changed: 2026-08-06T05:42:08.159Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# salary_of

**Source:** `demo/private-payroll/contracts/employee-registry/src/lib.rs:45`

## Signature

```rust
fn salary_of(env: Env, employee: Address) -> i128
```

## Connections

**Reads**
- [[storage/employeeregistry.persistent.datakey-salary-employee|DataKey::Salary(employee) (persistent)]] — `get`

**Defined in**
- [[contracts/employeeregistry|EmployeeRegistry]]

---

<details><summary>Where this came from</summary>

- Parsed from `demo/private-payroll/contracts/employee-registry/src/lib.rs:45`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
