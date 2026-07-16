#!/usr/bin/env bash
# scripts/deploy-contract.sh
#
# Build and deploy the Stellar-IndigoPay Soroban contracts.
#
# Usage:
#   ./scripts/deploy-contract.sh [--contract-type <name>] [--network <net>] [--identity <id>] [--relayer <addr>]
#
# `--contract-type` defaults to `indigopay` to preserve the existing
# behaviour. Pass `--contract-type attestation` to build & deploy the
# new `contracts/attestation-contract` crate instead (issue #125).
#
# Environment variables consumed:
#   STELLAR_NETWORK     – testnet|mainnet (defaults to testnet)
#
# After the contract id is printed, add it to your .env files:
#   CONTRACT_ID=$CONTRACT_ID            # for the indigopay contract
#   ATTESTATION_CONTRACT_ID=$CONTRACT_ID # for the attestation contract

set -euo pipefail

CONTRACT_TYPE="indigopay"
NETWORK="testnet"
IDENTITY="alice"
RELAYER_ADDRESS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --contract-type)
      CONTRACT_TYPE="$2"; shift 2 ;;
    --network)
      NETWORK="$2"; shift 2 ;;
    --identity)
      IDENTITY="$2"; shift 2 ;;
    --relayer)
      RELAYER_ADDRESS="$2"; shift 2 ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--contract-type <indigopay|attestation>] [--network <net>] [--identity <id>] [--relayer <addr>]
USAGE
      exit 0 ;;
    *)
      echo "❌ Unknown argument: $1"; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="wasm32v1-none"

case "$CONTRACT_TYPE" in
  indigopay)
    CONTRACT_DIR="$REPO_ROOT/contracts/indigopay-contract"
    WASM="$CONTRACT_DIR/target/$TARGET/release/indigopay_contract.wasm"
    INIT_FN_ARGS=""    # contract init args are populated below
    POST_INIT_INVOKE="" # nothing to call after initialize for indigopay
    ENV_KEY="CONTRACT_ID"
    ;;
  attestation)
    CONTRACT_DIR="$REPO_ROOT/contracts/attestation-contract"
    WASM="$CONTRACT_DIR/target/$TARGET/release/attestation_contract.wasm"
    POST_INIT_INVOKE="" # set below when RELAYER_ADDRESS is provided
    ENV_KEY="ATTESTATION_CONTRACT_ID"
    ;;
  *)
    echo "❌ Unknown --contract-type: $CONTRACT_TYPE"; exit 1 ;;
esac

echo "✦ Stellar-IndigoPay — Contract Deploy"
echo "   Network:       $NETWORK"
echo "   Identity:      $IDENTITY"
echo "   Contract type: $CONTRACT_TYPE"
echo "   WASM path:     $WASM"
echo ""

command -v stellar &>/dev/null || { echo "❌ stellar CLI not found. Run: cargo install --locked stellar-cli"; exit 1; }
command -v cargo   &>/dev/null || { echo "❌ Cargo not found. Install: https://rustup.rs"; exit 1; }

# ── ensure wasm32 target ────────────────────────────────────────────────────
if ! rustup target list --installed 2>/dev/null | grep -q "$TARGET"; then
  echo "➕ Installing target $TARGET..."
  rustup target add "$TARGET"
fi

echo "🔨 Building WASM..."
cd "$CONTRACT_DIR"
cargo build --target "$TARGET" --release
echo "   ✅ Built: $(du -sh "$WASM" | cut -f1)"
echo ""

echo "🚀 Deploying to $NETWORK..."
DEPLOY_OUT=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" 2>&1)
CONTRACT_ID=$(echo "$DEPLOY_OUT" | tr -d '\n\r ')
echo "✅ Deployed! Contract ID: $CONTRACT_ID"
echo ""

ADMIN_KEY=$(stellar keys address "$IDENTITY" 2>/dev/null || echo "")
if [[ -n "$ADMIN_KEY" ]]; then
  echo "🔧 Initializing contract..."
  case "$CONTRACT_TYPE" in
    indigopay)
      stellar contract invoke \
        --id "$CONTRACT_ID" \
        --source "$IDENTITY" \
        --network "$NETWORK" \
        -- initialize \
        --admin "$ADMIN_KEY" \
      && echo "   ✅ Initialized with admin: $ADMIN_KEY"
      ;;
    attestation)
      stellar contract invoke \
        --id "$CONTRACT_ID" \
        --source "$IDENTITY" \
        --network "$NETWORK" \
        -- initialize \
        --admin "$ADMIN_KEY" \
      && echo "   ✅ Initialized with admin: $ADMIN_KEY"
      if [[ -n "$RELAYER_ADDRESS" ]]; then
        echo "🔧 Setting relayer: $RELAYER_ADDRESS"
        stellar contract invoke \
          --id "$CONTRACT_ID" \
          --source "$IDENTITY" \
          --network "$NETWORK" \
          -- set_relayer \
          --admin "$ADMIN_KEY" \
          --relayer "$RELAYER_ADDRESS" \
          && echo "   ✅ Relayer registered: $RELAYER_ADDRESS"
      else
        echo "ℹ️  No --relayer supplied; skipping set_relayer."
        echo "   Run later with:"
        echo "     stellar contract invoke --id $CONTRACT_ID \\"
        echo "       --source $IDENTITY --network $NETWORK -- set_relayer \\"
        echo "       --admin $ADMIN_KEY --relayer <STELLAR_PUBLIC_KEY>"
      fi
      ;;
  esac
fi

echo ""
echo "──────────────────────────────────────────"
echo "  Add to your .env files:"
echo "  ${ENV_KEY}=$CONTRACT_ID"
echo "  NEXT_PUBLIC_${ENV_KEY}=$CONTRACT_ID"
if [[ "$CONTRACT_TYPE" == "attestation" && -n "$RELAYER_ADDRESS" ]]; then
  echo "  ATTESTATION_RELAYER_ADDRESS=$RELAYER_ADDRESS"
fi
echo "──────────────────────────────────────────"
