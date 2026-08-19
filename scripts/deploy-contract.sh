#!/usr/bin/env bash
# scripts/deploy-contract.sh
# Build, verify, and deploy the Stellar-IndigoPay Soroban contract, and
# record the deployment in the versioned registry at contracts/deployments.json
# (issue #921).
#
# Usage:
#   chmod +x scripts/deploy-contract.sh
#   ./scripts/deploy-contract.sh --network testnet [--identity alice]
#   ./scripts/deploy-contract.sh --network mainnet --identity prod-deployer --confirm
#
# Flags:
#   --network <testnet|mainnet>  Required. No default — a bare invocation
#                                with no network can never accidentally
#                                target mainnet.
#   --identity <name>            Soroban CLI identity to deploy with.
#                                Default: alice.
#   --confirm                    Required when --network mainnet. Without
#                                it the script aborts before touching the
#                                network.
#   --registry <path>            Registry file. Default:
#                                contracts/deployments.json (repo-relative).
#   --dry-run                    Build + hash + guardrail-check only.
#                                Does not deploy or write the registry.
#   --skip-verify                Skip the post-deploy on-chain hash check
#                                (e.g. when RPC is known-flaky). The
#                                deployment is still recorded, with
#                                verified=false and a reason, never as a
#                                silent success.
#   -h, --help                   Print this help and exit.
#
# Rollback: the registry is the audit trail for "what was deployed when."
# To roll back, find the previous verified entry for the target network in
# contracts/deployments.json, check out that entry's gitSha, rebuild, and
# re-deploy — Soroban has no in-place "revert" for a deployed contract, so
# rolling back means deploying the prior build as a fresh (new) contract id
# and repointing NEXT_PUBLIC_CONTRACT_ID / CONTRACT_ID at it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/contracts/indigopay-contract"
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/indigopay_contract.wasm"
REGISTRY_HELPER="$REPO_ROOT/backend/scripts/deploymentRegistry.js"

NETWORK=""
IDENTITY="alice"
CONFIRM="false"
REGISTRY="$REPO_ROOT/contracts/deployments.json"
DRY_RUN="false"
SKIP_VERIFY="false"

print_help() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --confirm) CONFIRM="true"; shift ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --skip-verify) SKIP_VERIFY="true"; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) echo "❌ Unknown argument: $1"; print_help; exit 2 ;;
  esac
done

echo "✦ Stellar-IndigoPay — Contract Deploy"
echo "   Network:  ${NETWORK:-<none specified>}"
echo "   Identity: $IDENTITY"
echo "   Dry run:  $DRY_RUN"
echo ""

# ── Guardrails ───────────────────────────────────────────────────────────────

if [[ -z "$NETWORK" ]]; then
  echo "❌ --network is required (testnet or mainnet). Refusing to guess." >&2
  exit 2
fi
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "❌ Unknown network: $NETWORK (expected testnet or mainnet)" >&2
  exit 2
fi

if [[ "$NETWORK" == "mainnet" ]]; then
  if [[ "$CONFIRM" != "true" ]]; then
    echo "❌ Deploying to mainnet requires --confirm. Refusing to proceed." >&2
    echo "   This is deliberate: mainnet mistakes are expensive and hard to undo." >&2
    exit 2
  fi
  # Reject the well-known testnet/example identity names as a mainnet
  # deployer — a real mainnet identity should never share a name with the
  # scripts' own testnet default, so this catches the "ran the testnet
  # command against mainnet by habit" mistake without needing to inspect
  # key material.
  case "$IDENTITY" in
    alice|bob|test|testnet|dev|default)
      echo "❌ Identity '$IDENTITY' looks like a testnet/example identity — refusing to use it for a mainnet deploy." >&2
      echo "   Pass a mainnet-specific --identity." >&2
      exit 2
      ;;
  esac
fi

command -v stellar &>/dev/null || { echo "❌ stellar CLI not found. Run: cargo install --locked stellar-cli" >&2; exit 1; }
command -v cargo   &>/dev/null || { echo "❌ Cargo not found. Install: https://rustup.rs" >&2; exit 1; }
command -v node    &>/dev/null || { echo "❌ node not found (needed for the deployment registry helper)." >&2; exit 1; }
command -v git     &>/dev/null || { echo "❌ git not found." >&2; exit 1; }

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- contracts 2>/dev/null)" ]]; then
  echo "⚠️  Uncommitted changes under contracts/ — the recorded gitSha ($GIT_SHA) will not exactly match the deployed bytecode's source." >&2
fi

# ── Build ────────────────────────────────────────────────────────────────────

echo "🔨 Building WASM..."
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release
echo "   ✅ Built: $(du -sh "$WASM" | cut -f1)"

WASM_SHA256="$(node "$REGISTRY_HELPER" hash "$WASM")"
echo "   WASM sha256: $WASM_SHA256"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "✅ Dry run complete — build and guardrail checks passed. No deploy, no registry write."
  echo "   Would deploy to: $NETWORK  (identity: $IDENTITY)"
  echo "   WASM sha256:     $WASM_SHA256"
  echo "   Git SHA:         $GIT_SHA"
  exit 0
fi

# ── Deploy ───────────────────────────────────────────────────────────────────

echo ""
echo "🚀 Deploying to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" 2>&1)

echo "✅ Deployed! Contract ID: $CONTRACT_ID"

DEPLOYER_ADDRESS=$(stellar keys address "$IDENTITY" 2>/dev/null || echo "")

# ── Post-deploy verification ────────────────────────────────────────────────
# Fetch the on-chain WASM and compare its hash against what we just built —
# never trust the deploy command's own exit code alone. If RPC is
# unavailable, that is reported (and recorded) rather than silently treated
# as a pass.

VERIFIED="true"
VERIFICATION_DETAIL=""

if [[ "$SKIP_VERIFY" == "true" ]]; then
  VERIFIED="false"
  VERIFICATION_DETAIL="skipped via --skip-verify"
  echo "⚠️  Post-deploy verification skipped (--skip-verify)."
else
  echo ""
  echo "🔍 Verifying deployed bytecode against the build..."
  FETCHED_WASM="$(mktemp -d)/deployed.wasm"
  if stellar contract fetch --id "$CONTRACT_ID" --network "$NETWORK" --out-file "$FETCHED_WASM" 2>/tmp/deploy-verify-stderr.log; then
    ONCHAIN_SHA256="$(node "$REGISTRY_HELPER" hash "$FETCHED_WASM")"
    if [[ "$ONCHAIN_SHA256" == "$WASM_SHA256" ]]; then
      echo "   ✅ On-chain WASM hash matches the build ($ONCHAIN_SHA256)"
    else
      VERIFIED="false"
      VERIFICATION_DETAIL="on-chain hash $ONCHAIN_SHA256 != build hash $WASM_SHA256"
      echo "❌ MISMATCH: on-chain WASM hash ($ONCHAIN_SHA256) does not match the build ($WASM_SHA256)" >&2
    fi
  else
    VERIFIED="false"
    VERIFICATION_DETAIL="RPC fetch failed: $(tail -c 300 /tmp/deploy-verify-stderr.log 2>/dev/null || echo unknown error)"
    echo "⚠️  Could not fetch on-chain WASM for verification — recording as unverified, not as a pass." >&2
  fi
fi

# ── Registry ─────────────────────────────────────────────────────────────────

DEPLOYED_AT="$(node -e 'console.log(new Date().toISOString())')"
ENV_LABEL="${DEPLOY_ENV:-${CI:+ci}}"
ENV_LABEL="${ENV_LABEL:-local}"

node "$REGISTRY_HELPER" record \
  --registry "$REGISTRY" \
  --network "$NETWORK" \
  --contract-id "$CONTRACT_ID" \
  --git-sha "$GIT_SHA" \
  --wasm-sha256 "$WASM_SHA256" \
  --deployed-at "$DEPLOYED_AT" \
  --identity "$IDENTITY" \
  --deployer-address "${DEPLOYER_ADDRESS:-unknown}" \
  --env "$ENV_LABEL" \
  --verified "$VERIFIED" \
  --verification-detail "$VERIFICATION_DETAIL"

if [[ -n "$DEPLOYER_ADDRESS" ]]; then
  echo ""
  echo "🔧 Initializing contract..."
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- initialize \
    --admin "$DEPLOYER_ADDRESS"
  echo "   ✅ Initialized with admin: $DEPLOYER_ADDRESS"
fi

echo ""
echo "──────────────────────────────────────────"
echo "  Add to your .env files:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID"
echo "  CONTRACT_ID=$CONTRACT_ID"
echo "──────────────────────────────────────────"
echo ""
echo "  Recorded in $REGISTRY (verified=$VERIFIED)"
if [[ "$VERIFIED" != "true" ]]; then
  echo "  ⚠️  $VERIFICATION_DETAIL"
fi
echo "──────────────────────────────────────────"
echo ""
echo "  Next: Register your first climate project:"
echo "  stellar contract invoke --id $CONTRACT_ID \\"
echo "    --source $IDENTITY --network $NETWORK \\"
echo "    -- register_project \\"
echo "    --admin ${DEPLOYER_ADDRESS:-<ADMIN_ADDRESS>} \\"
echo "    --project_id 'project-001' \\"
echo "    --name 'Amazon Reforestation' \\"
echo "    --wallet <PROJECT_WALLET_ADDRESS> \\"
echo "    --co2_per_xlm 8500"
echo "──────────────────────────────────────────"

if [[ "$SKIP_VERIFY" != "true" && "$VERIFIED" != "true" ]]; then
  echo "" >&2
  echo "❌ Deployment recorded but NOT verified: $VERIFICATION_DETAIL" >&2
  exit 1
fi
