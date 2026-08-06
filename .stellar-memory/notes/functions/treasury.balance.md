---
id: function:Treasury.balance
kind: function
title: balance
path: demo/private-payroll/contracts/treasury/src/lib.rs
first_seen: 2026-08-06T23:14:26.277Z
last_changed: 2026-08-06T23:14:26.277Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# balance

**Source:** `demo/private-payroll/contracts/treasury/src/lib.rs:91`

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

- Parsed from `demo/private-payroll/contracts/treasury/src/lib.rs:91`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
