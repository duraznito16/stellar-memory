---
id: storage:Payroll.persistent.DataKey::LastPaid(employee)
kind: storage
title: DataKey::LastPaid(employee) (persistent)
path: contracts/payroll/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-04T23:23:28.099Z
tags:
  - stellar-memory
  - kind/storage
---

<!-- stellar-memory:auto -->
# DataKey::LastPaid(employee) (persistent)

**Source:** `contracts/payroll/src/lib.rs:93`

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

- Parsed from `contracts/payroll/src/lib.rs:93`
- Parsed from `contracts/payroll/src/lib.rs:112`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
