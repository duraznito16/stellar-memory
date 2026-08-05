---
id: function:Treasury.initialize
kind: function
title: initialize
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T02:30:56.473Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# initialize

**Source:** `contracts/treasury/src/lib.rs:30`

## Signature

```rust
fn initialize(env: Env, admin: Address, payroll: Address)
```

## Authorization

- ⚠️ `require_auth` on `admin`, which is a **parameter supplied by the caller**. The caller proves control of an address they chose, so this does not restrict who may call it.

## Connections

**Writes**
- [[storage/treasury.instance.datakey-admin|DataKey::Admin (instance)]] — `set`
- [[storage/treasury.instance.datakey-payroll|DataKey::Payroll (instance)]] — `set`

**Defined in**
- [[contracts/treasury|Treasury]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:30`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
