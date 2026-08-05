---
id: function:Treasury.balance
kind: function
title: balance
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-04T23:23:28.099Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# balance

**Source:** `contracts/treasury/src/lib.rs:85`

## Signature

```rust
fn balance(env: Env, token: Address) -> i128
```

## Connections

**Reads**
- [[storage/treasury.persistent.datakey-balance-token|DataKey::Balance(token) (persistent)]] — `get`

**Defined in**
- [[contracts/treasury|Treasury]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:85`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
