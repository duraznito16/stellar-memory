---
id: function:Payroll.last_paid
kind: function
title: last_paid
path: contracts/payroll/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# last_paid

**Source:** `contracts/payroll/src/lib.rs:111`

## Signature

```rust
fn last_paid(env: Env, employee: Address) -> u32
```

## Connections

**Reads**
- [[storage/payroll.persistent.datakey-lastpaid-employee|DataKey::LastPaid(employee) (persistent)]] — `get`

**Defined in**
- [[contracts/payroll|Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:111`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
