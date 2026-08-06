---
id: asset:Token.token
kind: asset
title: Token (token)
path: contracts/treasury/src/lib.rs
summary: Token contract this project moves value through.
first_seen: 2026-08-06T05:42:22.027Z
last_changed: 2026-08-06T05:42:22.027Z
tags:
  - stellar-memory
  - kind/asset
---

<!-- stellar-memory:auto -->
# Token (token)

Token contract this project moves value through.

**Source:** `contracts/treasury/src/lib.rs:56`

## Value path

- Reached through a **token client**.
- ⚠️ Address is **supplied by the caller**, not read from storage — callers choose which contract this talks to.

**Methods this project calls:** `transfer`

## Connections

**Called by**
- [[functions/treasury.withdraw|withdraw]] — calls `transfer`

---

<details><summary>Where this came from</summary>

- Parsed from `contracts/treasury/src/lib.rs:56`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
