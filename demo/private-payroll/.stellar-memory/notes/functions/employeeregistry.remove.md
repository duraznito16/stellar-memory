---
id: function:EmployeeRegistry.remove
kind: function
title: remove
path: contracts/employee-registry/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# remove

**Source:** `contracts/employee-registry/src/lib.rs:36`

## Signature

```rust
fn remove(env: Env, employee: Address)
```

## Authorization

- `require_auth` on `admin`, loaded from `DataKey::Admin` — this restricts callers to the stored address.

## Connections

**Reads**
- [[storage/employeeregistry.instance.datakey-admin|DataKey::Admin (instance)]] — `get`

**Writes**
- [[storage/employeeregistry.persistent.datakey-salary-employee|DataKey::Salary(employee) (persistent)]] — `remove`

**Defined in**
- [[contracts/employeeregistry|EmployeeRegistry]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/employee-registry/src/lib.rs:36`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
