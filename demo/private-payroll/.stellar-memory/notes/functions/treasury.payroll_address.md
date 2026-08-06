---
id: function:Treasury.payroll_address
kind: function
title: payroll_address
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# payroll_address

**Source:** `contracts/treasury/src/lib.rs:98`

## Signature

```rust
fn payroll_address(env: Env) -> Result<Address, TreasuryError>
```

## Connections

**Reads**
- [[storage/treasury.instance.datakey-payroll|DataKey::Payroll (instance)]] — `get`

**Can fail with**
- [[errors/treasury.treasuryerror|TreasuryError]]

**Defined in**
- [[contracts/treasury|Treasury]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:98`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
