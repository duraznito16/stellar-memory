---
id: error:payroll.PayrollError
kind: error
title: PayrollError
path: contracts/payroll/src/lib.rs
summary: Contract error enum with 4 variants. The discriminants are published ABI.
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/error
---

<!-- stellar-memory:auto -->
# PayrollError

Contract error enum with 4 variants. The discriminants are published ABI.

**Source:** `contracts/payroll/src/lib.rs:28`

## Variants

These discriminants are published ABI. A client matches on the integer, and a
failed invocation reaches the caller as `Error(Contract, #N)` — so renumbering
an existing variant breaks integrations without breaking the build.

| Variant | Code |
|---|---:|
| `NotAuthorized` | 1 |
| `UnknownEmployee` | 2 |
| `AlreadyPaidThisPeriod` | 3 |
| `NotInitialized` | 4 |

## Connections

**Raised by**
- [[functions/payroll.pay|pay]]

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/payroll/src/lib.rs:28`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
