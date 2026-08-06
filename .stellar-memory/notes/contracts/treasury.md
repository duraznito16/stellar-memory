---
id: contract:Treasury
kind: contract
title: Treasury
path: demo/private-payroll/contracts/treasury/src/lib.rs
summary: Soroban contract with 5 public functions.
first_seen: 2026-08-06T18:12:12.243Z
last_changed: 2026-08-06T18:12:12.243Z
tags:
  - stellar-memory
  - kind/contract
---

<!-- stellar-memory:auto -->
# Treasury

Soroban contract with 5 public functions.

**Source:** `demo/private-payroll/contracts/treasury/src/lib.rs:24`

## Interface

- `initialize(env: Env, admin: Address, payroll: Address)`  🔒 requires auth — [[functions/treasury.initialize|initialize]]
- `fund(env: Env, token: Address, amount: i128) -> Result<i128, TreasuryError>`  🔒 requires auth — [[functions/treasury.fund|fund]]
- `withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<i128, TreasuryError>`  🔒 requires auth — [[functions/treasury.withdraw|withdraw]]
- `balance(env: Env, token: Address) -> i128` — [[functions/treasury.balance|balance]]
- `payroll_address(env: Env) -> Result<Address, TreasuryError>` — [[functions/treasury.payroll_address|payroll_address]]

## Connections

**Defined in**
- [[crates/treasury|treasury]]
- [[semillero|Semillero]]

**Called by**
- [[contracts/payroll|Payroll]] — via `treasury::Client` in `pay`
- [[functions/payroll.pay|pay]] — calls `withdraw` — address from `DataKey::Treasury`

**Tested by**
- [[tests/demo/private-payroll/contracts/payroll/src/test.rs|payroll/test.rs]]
- [[tests/demo/private-payroll/contracts/treasury/src/test.rs|treasury/test.rs]]

**Documented in**
- [[docs/.claude/agents/mcp-tooling|mcp-tooling.md]]
- [[docs/.claude/agents/release-verify|release-verify.md]]
- [[docs/demo/private-payroll/readme|README.md]]
- [[docs/docs/roadmap|ROADMAP.md]]
- [[docs/readme|README.md]]
- [[docs/templates/agents/stellar-explorer|stellar-explorer.md]]
- [[docs/templates/agents/stellar-resume|stellar-resume.md]]

**Mentioned in**
- [[tasks/demo/private-payroll/contracts/payroll/src/test.rs-23|pay() needs an end-to-end test with a real Treasury and]]

---

<details><summary>Where this came from</summary>

- Parsed from `demo/private-payroll/contracts/treasury/src/lib.rs:24`

</details>
<!-- /stellar-memory:auto -->

## Notes

<!-- Anything you write below is yours. stellar-memory will never overwrite it. -->
