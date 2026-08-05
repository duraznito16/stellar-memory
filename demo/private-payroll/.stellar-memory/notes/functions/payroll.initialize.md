---
id: function:Payroll.initialize
kind: function
title: initialize
path: contracts/payroll/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T02:30:56.473Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# initialize

**Source:** `contracts/payroll/src/lib.rs:43`

## Signature

```rust
fn initialize(env: Env, admin: Address, treasury_id: Address, registry_id: Address, pay_token: Address)
```

## Authorization

- ⚠️ `require_auth` on `admin`, which is a **parameter supplied by the caller**. The caller proves control of an address they chose, so this does not restrict who may call it.

## Connections

**Writes**
- [[storage/payroll.instance.datakey-admin|DataKey::Admin (instance)]] — `set`
- [[storage/payroll.instance.datakey-treasury|DataKey::Treasury (instance)]] — `set`
- [[storage/payroll.instance.datakey-registry|DataKey::Registry (instance)]] — `set`
- [[storage/payroll.instance.datakey-paytoken|DataKey::PayToken (instance)]] — `set`

**Defined in**
- [[contracts/payroll|Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:43`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
