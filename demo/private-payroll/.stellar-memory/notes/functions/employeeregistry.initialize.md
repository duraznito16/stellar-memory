---
id: function:EmployeeRegistry.initialize
kind: function
title: initialize
path: contracts/employee-registry/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T02:30:56.473Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# initialize

**Source:** `contracts/employee-registry/src/lib.rs:17`

## Signature

```rust
fn initialize(env: Env, admin: Address)
```

## Authorization

- ⚠️ `require_auth` on `admin`, which is a **parameter supplied by the caller**. The caller proves control of an address they chose, so this does not restrict who may call it.

## Connections

**Writes**
- [[storage/employeeregistry.instance.datakey-admin|DataKey::Admin (instance)]] — `set`

**Defined in**
- [[contracts/employeeregistry|EmployeeRegistry]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/employee-registry/src/lib.rs:17`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
