---
id: function:Treasury.fund
kind: function
title: fund
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T02:30:56.473Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# fund

**Source:** `contracts/treasury/src/lib.rs:37`

## Signature

```rust
fn fund(env: Env, token: Address, amount: i128) -> Result<i128, TreasuryError>
```

## Authorization

- `require_auth` on `admin`, loaded from `DataKey::Admin` — this restricts callers to the stored address.

## Connections

**Reads**
- [[storage/treasury.instance.datakey-admin|DataKey::Admin (instance)]] — `get`
- [[storage/treasury.persistent.datakey-balance-token|DataKey::Balance(token) (persistent)]] — `get`

**Writes**
- [[storage/treasury.persistent.datakey-balance-token|DataKey::Balance(token) (persistent)]] — `set`

**Can fail with**
- [[errors/treasuryerror|TreasuryError]]

**Emits**
- [[events/treasury.funded|funded]]

**Defined in**
- [[contracts/treasury|Treasury]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:37`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
