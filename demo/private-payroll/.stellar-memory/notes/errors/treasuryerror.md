---
id: error:TreasuryError
kind: error
title: TreasuryError
path: contracts/treasury/src/lib.rs
summary: Contract error enum with 3 variants. The discriminants are published ABI.
first_seen: 2026-08-04T23:23:28.099Z
last_changed: 2026-08-05T03:42:03.854Z
tags:
  - stellar-memory
  - kind/error
---

<!-- stellar-memory:auto -->
# TreasuryError

Contract error enum with 3 variants. The discriminants are published ABI.

**Source:** `contracts/treasury/src/lib.rs:15`

## Variants

These discriminants are published ABI. A client matches on the integer, and a
failed invocation reaches the caller as `Error(Contract, #N)` — so renumbering
an existing variant breaks integrations without breaking the build.

| Variant | Code |
|---|---:|
| `NotAuthorized` | 1 |
| `InsufficientFunds` | 2 |
| `NotInitialized` | 3 |

## Connections

**Raised by**
- [[functions/treasury.fund|fund]]
- [[functions/treasury.withdraw|withdraw]]
- [[functions/treasury.payroll_address|payroll_address]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:15`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
