#!/usr/bin/env bash
# Build and deploy the payroll system to a network.
#
#   ./scripts/deploy.sh testnet alice
set -euo pipefail

NETWORK="${1:-testnet}"
SOURCE="${2:-alice}"

echo "Building contracts…"
stellar contract build

deploy() {
  local name="$1"
  local wasm="target/wasm32v1-none/release/${2}.wasm"
  echo "Deploying ${name}…"
  stellar contract deploy \
    --wasm "$wasm" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --alias "$name"
}

deploy treasury treasury
deploy employee-registry employee_registry
deploy payroll payroll

echo
echo "Deployed. Aliases are recorded in .stellar/contract-ids/."
echo "Run 'stellar-memory scan' to link them into the project memory."

# TODO: wire up initialize() calls here so a fresh deploy is usable immediately.
