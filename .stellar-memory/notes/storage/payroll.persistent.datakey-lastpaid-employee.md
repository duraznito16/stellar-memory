---
id: storage:Payroll.persistent.DataKey::LastPaid(employee)
kind: storage
title: DataKey::LastPaid(employee) (persistent)
path: demo/private-payroll/contracts/payroll/src/lib.rs
first_seen: 2026-08-06T05:42:08.159Z
last_changed: 2026-08-06T05:42:08.159Z
tags:
  - stellar-memory
  - kind/storage
---

<!-- stellar-memory:auto -->
# DataKey::LastPaid(employee) (persistent)

**Source:** `demo/private-payroll/contracts/payroll/src/lib.rs:93`

## Storage

- **Durability:** `persistent`
- **Key:** `DataKey::LastPaid(employee)`
- ⚠️ No `extend_ttl` call was found for this key. persistent entries expire once their TTL lapses, and the data becomes unreachable.

## Connections

**Written by**
- [[functions/payroll.pay|pay]] — `set`

**Read by**
- [[functions/payroll.last_paid|last_paid]] — `get`

---

<details><summary>Where this came from</summary>

- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:93`
- Parsed from `demo/private-payroll/contracts/payroll/src/lib.rs:112`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
