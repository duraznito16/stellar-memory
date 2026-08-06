---
id: function:Payroll.last_paid
kind: function
title: last_paid
path: demo/private-payroll/contracts/payroll/src/lib.rs
first_seen: 2026-08-06T23:14:26.277Z
last_changed: 2026-08-06T23:14:26.277Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# last_paid

**Source:** `demo/private-payroll/contracts/payroll/src/lib.rs:111`

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

- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:111`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
