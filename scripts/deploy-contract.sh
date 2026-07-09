#!/usr/bin/env bash
# scripts/deploy-contract.sh
# Build and deploy the IndigoPay Soroban contract.
#
# Usage:
#   chmod +x scripts/deploy-contract.sh
#   ./scripts/deploy-contract.sh [testnet|mainnet] [identity]

set -euo pipefail

NETWORK=${1:-testnet}
IDENTITY=${2:-alice}
CONTRACT_DIR="$(dirname "$0")/../contracts/indigopay-contract"
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/indigopay_contract.wasm"

echo "🌱 Stellar IndigoPay — Contract Deploy"
echo "   Network:  $NETWORK"
echo "   Identity: $IDENTITY"
echo ""

command -v stellar &>/dev/null || { echo "❌ stellar CLI not found. Run: cargo install --locked stellar-cli"; exit 1; }
command -v cargo   &>/dev/null || { echo "❌ Cargo not found. Install: https://rustup.rs"; exit 1; }

echo "🔨 Building WASM..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release
echo "   ✅ Built: $(du -sh "$WASM" | cut -f1)"

echo ""
echo "🚀 Deploying to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" 2>&1)

echo "✅ Deployed! Contract ID: $CONTRACT_ID"

ADMIN_KEY=$(stellar keys address "$IDENTITY" 2>/dev/null || echo "")
if [[ -n "$ADMIN_KEY" ]]; then
  echo ""
  echo "🔧 Initializing contract..."
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- initialize \
    --admin "$ADMIN_KEY"
  echo "   ✅ Initialized with admin: $ADMIN_KEY"
fi

echo ""
echo "──────────────────────────────────────────"
echo "  Add to your .env files:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID"
echo "  CONTRACT_ID=$CONTRACT_ID"
echo "──────────────────────────────────────────"
echo ""
echo "  Next: Register your first climate project:"
echo "  stellar contract invoke --id $CONTRACT_ID \\"
echo "    --source $IDENTITY --network $NETWORK \\"
echo "    -- register_project \\"
echo "    --admin $ADMIN_KEY \\"
echo "    --project_id 'project-001' \\"
echo "    --name 'Amazon Reforestation' \\"
echo "    --wallet <PROJECT_WALLET_ADDRESS> \\"
echo "    --co2_per_xlm 8500"
echo "──────────────────────────────────────────"
