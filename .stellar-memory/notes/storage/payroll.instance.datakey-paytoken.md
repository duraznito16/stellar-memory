---
id: storage:Payroll.instance.DataKey::PayToken
kind: storage
title: DataKey::PayToken (instance)
path: demo/private-payroll/contracts/payroll/src/lib.rs
first_seen: 2026-08-06T05:30:18.137Z
last_changed: 2026-08-06T05:30:18.137Z
tags:
  - stellar-memory
  - kind/storage
---

<!-- stellar-memory:auto -->
# DataKey::PayToken (instance)

**Source:** `demo/private-payroll/contracts/payroll/src/lib.rs:54`

## Storage

- **Durability:** `instance`
- **Key:** `DataKey::PayToken`
- ⚠️ No `extend_ttl` call was found for this key. instance entries expire once their TTL lapses, and the data becomes unreachable.

## Connections

**Written by**
- [[functions/payroll.initialize|initialize]] — `set`
- [[functions/payroll.set_pay_token|set_pay_token]] — `set`

**Read by**
- [[functions/payroll.pay|pay]] — `get`

---

<details><summary>Where this came from</summary>

- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:54`
- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:83`
- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:105`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
