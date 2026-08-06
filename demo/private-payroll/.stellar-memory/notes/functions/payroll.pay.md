---
id: function:Payroll.pay
kind: function
title: pay
path: contracts/payroll/src/lib.rs
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/function
---

<!-- stellar-memory:auto -->
# pay

**Source:** `contracts/payroll/src/lib.rs:58`

## Signature

```rust
fn pay(env: Env, employee: Address) -> Result<i128, PayrollError>
```

## Authorization

- `require_auth` on `admin`, loaded from `DataKey::Admin` — this restricts callers to the stored address.

## Connections

**Reads**
- [[storage/payroll.instance.datakey-admin|DataKey::Admin (instance)]] — `get`
- [[storage/payroll.instance.datakey-registry|DataKey::Registry (instance)]] — `get`
- [[storage/payroll.instance.datakey-treasury|DataKey::Treasury (instance)]] — `get`
- [[storage/payroll.instance.datakey-paytoken|DataKey::PayToken (instance)]] — `get`

**Writes**
- [[storage/payroll.persistent.datakey-lastpaid-employee|DataKey::LastPaid(employee) (persistent)]] — `set`

**Can fail with**
- [[errors/payroll.payrollerror|PayrollError]]

**Emits**
- [[events/payroll.paid|paid]]

**Calls**
- [[contracts/employeeregistry|EmployeeRegistry]] — calls `salary_of` — address from `DataKey::Registry`
- [[contracts/treasury|Treasury]] — calls `withdraw` — address from `DataKey::Treasury`

**Defined in**
- [[contracts/payroll|Payroll]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:58`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
