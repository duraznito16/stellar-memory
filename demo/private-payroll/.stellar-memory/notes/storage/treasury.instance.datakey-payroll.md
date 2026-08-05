---
id: storage:Treasury.instance.DataKey::Payroll
kind: storage
title: DataKey::Payroll (instance)
path: contracts/treasury/src/lib.rs
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-04T23:23:28.099Z
tags:
  - stellar-memory
  - kind/storage
---

<!-- stellar-memory:auto -->
# DataKey::Payroll (instance)

**Source:** `contracts/treasury/src/lib.rs:33`

## Storage

- **Durability:** `instance`
- **Key:** `DataKey::Payroll`
- ⚠️ No `extend_ttl` call was found for this key. instance entries expire once their TTL lapses, and the data becomes unreachable.

## Connections

**Written by**
- [[functions/treasury.initialize|initialize]] — `set`

**Read by**
- [[functions/treasury.withdraw|withdraw]] — `get`
- [[functions/treasury.payroll_address|payroll_address]] — `get`

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:33`
- Parsed from `contracts/treasury/src/lib.rs:63`
- Parsed from `contracts/treasury/src/lib.rs:99`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
