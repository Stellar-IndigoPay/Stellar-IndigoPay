#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-deployment.sh <CONTRACT_ID> <DEPLOYER_ADDRESS> <WASM_FILE>
CONTRACT_ID=${1:-}
DEPLOYER_ADDRESS=${2:-}
WASM_FILE=${3:-}

if [ -z "$CONTRACT_ID" ] || [ -z "$DEPLOYER_ADDRESS" ] || [ -z "$WASM_FILE" ]; then
  echo "Usage: $0 <CONTRACT_ID> <DEPLOYER_ADDRESS> <WASM_FILE>"
  exit 1
fi

if ! command -v stellar &> /dev/null; then
  echo "❌ stellar CLI is required but not installed."
  exit 1
fi

echo "================================================="
echo "Verifying deployment of $CONTRACT_ID..."
echo "================================================="

# 1. Fetch the WASM and compare hash
echo "1. Checking WASM hash..."
EXPECTED_HASH=$(sha256sum "$WASM_FILE" | awk '{print $1}')

stellar contract fetch --id "$CONTRACT_ID" --network testnet --out-file /tmp/deployed.wasm
ACTUAL_HASH=$(sha256sum /tmp/deployed.wasm | awk '{print $1}')

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "❌ Hash mismatch! Expected $EXPECTED_HASH, got $ACTUAL_HASH"
  exit 1
fi
echo "✅ Hash matches: $EXPECTED_HASH"

# 2. Check get_admin
echo "2. Checking contract initialization (admin)..."
ACTUAL_ADMIN_RAW=$(stellar contract invoke --id "$CONTRACT_ID" --network testnet -- get_admin)
ACTUAL_ADMIN=$(echo "$ACTUAL_ADMIN_RAW" | tr -d '"')
if [ "$ACTUAL_ADMIN" != "$DEPLOYER_ADDRESS" ]; then
  echo "❌ Admin mismatch! Expected $DEPLOYER_ADDRESS, got $ACTUAL_ADMIN"
  exit 1
fi
echo "✅ Admin matches: $DEPLOYER_ADDRESS"

# 3. Check get_global_stats for zero-state
echo "3. Checking zero-state global stats..."
GLOBAL_STATS=$(stellar contract invoke --id "$CONTRACT_ID" --network testnet -- get_global_stats)
echo "Global stats: $GLOBAL_STATS"

NON_ZERO=$(echo "$GLOBAL_STATS" | jq -r '
  to_entries
  | map(select((.value | tostring | tonumber?) != 0))
  | length')
if [ "${NON_ZERO:-1}" != "0" ]; then
  echo "❌ Global stats are not zero! Output: $GLOBAL_STATS"
  exit 1
fi
echo "✅ Global stats are zero-state."

# 4. register_project
echo "4. Testing register_project..."
PROJECT_ID="proj_$(date +%s)"
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- register_project \
  --admin "$DEPLOYER_ADDRESS" \
  --project_id "$PROJECT_ID" \
  --name "Smoke Test Project" \
  --wallet "$DEPLOYER_ADDRESS" \
  --co2_per_xlm 8500

echo "✅ Project $PROJECT_ID registered."

# 5. donate and assert event
echo "5. Testing donate..."
# Native token on testnet
NATIVE_TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
DONATION_AMOUNT=10000000 # 1 XLM

START_LEDGER=$(curl -s https://horizon-testnet.stellar.org | jq '.core_latest_ledger')

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- donate \
  --token "$NATIVE_TOKEN" \
  --donor "$DEPLOYER_ADDRESS" \
  --project_id "$PROJECT_ID" \
  --amount "$DONATION_AMOUNT" \
  --msg_hash 0

echo "✅ Donation successful."

# Verify event was emitted
echo "6. Verifying event emission..."
sleep 3
EVENTS=$(stellar events --id "$CONTRACT_ID" --network testnet --start-ledger "$START_LEDGER" --count 10)
if echo "$EVENTS" | grep -q "$PROJECT_ID" && echo "$EVENTS" | grep -qi "donat"; then
  echo "✅ Found donation event for $PROJECT_ID"
else
  echo "❌ Expected event not found in recent events!"
  exit 1
fi

echo "================================================="
echo "✅ Deployment verification completed successfully!"
echo "================================================="
