---
id: function:Treasury.withdraw
kind: function
title: withdraw
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# withdraw

**Source:** `contracts/treasury/src/lib.rs:56`

## Signature

```rust
fn withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<i128, TreasuryError>
```

## Authorization

- `require_auth` on `payroll`, loaded from `DataKey::Payroll` — this restricts callers to the stored address.

## Connections

**Reads**
- [[storage/treasury.instance.datakey-payroll|DataKey::Payroll (instance)]] — `get`
- [[storage/treasury.persistent.datakey-balance-token|DataKey::Balance(token) (persistent)]] — `get`

**Writes**
- [[storage/treasury.persistent.datakey-balance-token|DataKey::Balance(token) (persistent)]] — `set`

**Can fail with**
- [[errors/treasury.treasuryerror|TreasuryError]]

**Calls**
- [[assets/token.token|Token (token)]] — calls `transfer`

**Emits**
- [[events/treasury.withdrawn|withdrawn]]

**Defined in**
- [[contracts/treasury|Treasury]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:56`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
