---
id: function:Payroll.set_pay_token
kind: function
title: set_pay_token
path: contracts/payroll/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# set_pay_token

**Source:** `contracts/payroll/src/lib.rs:104`

## Signature

```rust
fn set_pay_token(env: Env, token: Address)
```

## Connections

**Writes**
- [[storage/payroll.instance.datakey-paytoken|DataKey::PayToken (instance)]] — `set`

**Emits**
- [[events/payroll.token_changed|token_changed]]

**Defined in**
- [[contracts/payroll|Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:104`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
