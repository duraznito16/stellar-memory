# Private Payroll

Confidential payroll payments on Stellar. A company funds a Treasury once, and
the Payroll contract pays employees from it on a schedule without revealing
individual salaries on-chain — only aggregate treasury movements are public.

## Architecture

```
Company → Treasury → Payroll → Employee
                 ↘ EmployeeRegistry
```

- **Treasury** holds the company's token balance and is the only contract
  allowed to move funds out.
- **Payroll** is the orchestrator: it looks up an employee in the registry,
  asks the Treasury to release funds, and records the payment.
- **EmployeeRegistry** maps employee addresses to their salary band.

## Status

- [x] Treasury implemented and deployed to testnet
- [x] Multi-token support added in v0.3
- [ ] Complete withdrawal tests for Payroll
- [ ] Audit the registry's access control before mainnet

## Live on testnet

These are real deployments; you can verify every claim the memory makes about
them with the Stellar CLI.

| Contract | Address |
|---|---|
| Treasury | `CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R` |
| EmployeeRegistry | `CA2UQYD63JWH5MXVEMTPIWEQZ2EQ7DLBUMZROWTKBN5UFLYCL7O2TWRN` |
| Payroll | `CDVMJUZ4YZIG6JME7LGVEW6MPNTV5DKR6VCAZLNRADINPLDVHLB4Z7XU` |
| Pay token (native XLM SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

**Treasury is deliberately out of sync.** A `payroll_address` getter was added to
the local source and rebuilt, but never redeployed — so the Wasm running on
testnet is older than this tree. That is the drift `stellar-memory scan` detects
by comparing Wasm hashes:

A Wasm hash is the SHA-256 of the file, so the local half needs nothing but a
digest, and the deployed half is one read away:

```bash
# what this tree builds
shasum -a 256 target/wasm32v1-none/release/treasury.wasm

# what testnet is actually running
stellar contract fetch \
  --id CDNR3WXJIY7GCZGY6KKFUW3BV3H5K654Y4IIPD4ZWURHNGKFHHYARE4R \
  --network testnet --out-file /tmp/treasury-onchain.wasm
shasum -a 256 /tmp/treasury-onchain.wasm
```

The two differ, and `stellar-memory scan` reports it as `stale`. On Windows,
`Get-FileHash -Algorithm SHA256` is the digest. `contract fetch` downloads and
nothing else — every network call this tool makes is read-only.

## Defects

This project is a fixture. Three of its problems were planted:

1. `DataKey::LastPaid` is persistent but never given an `extend_ttl` — it can
   expire and let an employee be paid twice in a period.
2. `Payroll.set_pay_token` changes state without `require_auth`.
3. Treasury's deployed build is older than its source (above).

**Four more were found by the tool, not planted by its author.** All three
`initialize` functions call `require_auth` on an `admin` address the caller
supplies, then write `DataKey::Admin` with no re-initialization guard — so anyone
can call them and become admin. And every test module calls `mock_all_auths`, so
the suite never exercises the access control it appears to test.

They are left unfixed on purpose: a memory that only reports the bugs its author
already knew about is not evidence of anything.

## What must never be reported

False positives are the failure mode that matters. These are all correct code and
must stay silent:

- `balance`, `salary_of`, `last_paid`, `payroll_address` — read-only getters.
- `DataKey::Balance` and `DataKey::Salary` — both do extend their TTLs.
- A SEP-41 `transfer` calling `from.require_auth()` on its own parameter is the
  correct pattern, not an unguarded entry point.

## Building and deploying

```bash
cargo build --target wasm32v1-none --release
./scripts/deploy.sh testnet <your-identity>
```
