# Mainnet Deployment — Complete Checklist & Step-by-Step Guide

This is the exhaustive, step-by-step runbook for deploying Stellar-IndigoPay to Stellar Mainnet. It consolidates and expands upon `docs/deployment-mainnet.md`, `docs/DEPLOYMENT.md`, the contract upgrade docs, the deploy script, and production infrastructure configs.

> **Estimated total time:** 2–3 days (including 48h upgrade timelock verification)
> **Minimum viable:** ~4 hours (slim contract + backend + frontend)
> **Risk level:** High — involves real XLM, real funds, irreversible contract deployment

---

## Phase 0 — Pre-Flight Preparation

### 0.1 Generate Mainnet Identity

```bash
# Create a dedicated mainnet deployer identity
stellar keys generate --global mainnet-deployer

# Save the public key
stellar keys address mainnet-deployer
# → G...

# Back up the secret seed securely (NEVER commit this)
stellar keys show mainnet-deployer
# → S...
```

**⚠️ SECURITY:** Store the seed in a hardware wallet, password manager, or HSM. This identity will control the contract admin. If compromised, the 48h upgrade timelock is your ONLY defense — rotate and cancel immediately.

### 0.2 Fund the Deployer Account

The deployer account needs real XLM on Mainnet. Minimum: ~50 XLM (contract deployment + initialization + project registration fees).

1. Send XLM to the deployer address from an exchange or existing wallet
2. Verify the balance:
   ```bash
   stellar account show mainnet-deployer --network mainnet
   ```

### 0.3 Create Admin Multi-Sig Identity

The contract supports M-of-N multi-sig (Phase B). Decide your admin configuration:

| Model | Description | Recommended for |
|---|---|---|
| **1-of-1** | Single key (backward compatible, Phase A) | Solo dev, early mainnet |
| **2-of-3** | Three admins, any two sign | Small team |
| **3-of-5** | Five admins, any three sign | Production DAO |

For initial mainnet deployment, **1-of-1 with the deployer key** is acceptable. Migrate to M-of-N POST-deployment via `add_admin` + `update_threshold`.

Generate additional identities if using M-of-N:

```bash
stellar keys generate --global mainnet-admin-2
stellar keys generate --global mainnet-admin-3
stellar keys address mainnet-admin-2  # record
stellar keys address mainnet-admin-3  # record
```

### 0.4 Prepare Project Wallet Addresses

Identify the real climate project wallets that will receive donations. Each needs:

- A valid, funded Stellar Mainnet account
- A secure custodian (project owner controls the key)
- Trustlines for any non-XLM assets (USDC, etc.)

For initial registration, have at least 3 projects ready with verified wallet addresses.

### 0.5 Audit Pre-Flight Checklist

- [ ] All contract tests pass: `cargo test --features testutils --workspace -- --skip fuzz`
- [ ] WASM builds clean: `cargo build --workspace --target wasm32v1-none --release`
- [ ] WASM size under 64KB (slim): `wasm-opt -Oz` → check
- [ ] CI green on main branch
- [ ] No secrets in git (`gitleaks detect --no-git`)
- [ ] `backend/.env` and `frontend/.env.local` are NOT committed
- [ ] Deployer seed backed up securely
- [ ] Project wallet addresses confirmed with project owners

---

## Phase 1 — Contract Deployment (Soroban Mainnet)

### 1.1 Build the WASM

```bash
cd contracts

# Full feature build (for optimized contract)
cargo build --workspace --target wasm32v1-none --release

# Slim build (for minimal initial deployment)
cargo build --workspace --target wasm32v1-none --release --no-default-features

# Verify WASM sizes
ls -lh target/wasm32v1-none/release/indigopay_contract.wasm
wasm-opt -Oz target/wasm32v1-none/release/indigopay_contract.wasm \
  -o target/wasm32v1-none/release/indigopay_contract.opt.wasm
stat -c%s target/wasm32v1-none/release/indigopay_contract.opt.wasm
```

**Decision point:** Deploy the **optimized contract** (all default features, ~103KB after wasm-opt) for full functionality, or the **slim contract** (~51KB) for a minimal initial footprint. The optimized contract is recommended for mainnet — it supports donations, campaigns, governance, and everything else.

### 1.2 Deploy to Mainnet

```bash
# Using the deployment script (recommended)
chmod +x scripts/deploy-contract.sh
./scripts/deploy-contract.sh mainnet mainnet-deployer
```

Or manually:

```bash
CONTRACT_ID=$(stellar contract deploy \
  --wasm contracts/target/wasm32v1-none/release/indigopay_contract.wasm \
  --source mainnet-deployer \
  --network mainnet)

echo "CONTRACT_ID=$CONTRACT_ID"
```

**✅ CHECKPOINT:** Record the contract ID. Save the deployment transaction hash from Stellar Expert. These are permanent artifacts.

### 1.3 Initialize the Contract

```bash
ADMIN_KEY=$(stellar keys address mainnet-deployer)

# Single-admin initialization
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- initialize \
  --admins "[\"$ADMIN_KEY\"]" \
  --threshold 1

echo "Contract initialized with admin: $ADMIN_KEY"
```

**Verify initialization:**

```bash
# Check admin set
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- get_admin_set

# Check contract is not paused
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- is_contract_paused
```

### 1.4 Verify On-Chain

1. Visit `https://stellar.expert/explorer/public/contract/$CONTRACT_ID`
2. Confirm the contract exists and shows the initialization transaction
3. Save the URL for documentation

**✅ CHECKPOINT:** Contract deployed, initialized, and verified on Stellar Expert.

---

## Phase 2 — Project Registration

### 2.1 Register Initial Projects

```bash
# Register project 1
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- register_project \
  --admin "$ADMIN_KEY" \
  --project_id "amazon-reforestation" \
  --name "Amazon Reforestation Initiative" \
  --wallet "G..." \
  --co2_per_xlm 8500

# Register project 2
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- register_project \
  --admin "$ADMIN_KEY" \
  --project_id "solar-kenya" \
  --name "Solar Kenya Initiative" \
  --wallet "G..." \
  --co2_per_xlm 6200

# Register project 3
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- register_project \
  --admin "$ADMIN_KEY" \
  --project_id "ocean-cleanup-pacific" \
  --name "Pacific Ocean Cleanup" \
  --wallet "G..." \
  --co2_per_xlm 4100
```

**CO₂ rate guidelines** (grams CO₂ per XLM):
- Reforestation: 6,000–12,000
- Renewable energy: 3,000–7,000
- Ocean/water cleanup: 2,000–5,000
- Conservation: 1,000–4,000

### 2.2 Verify Projects

```bash
# List all projects
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  -- get_project_count

# Read individual project
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  -- get_project --project_id "amazon-reforestation"

# Check global stats
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  -- get_global_stats
```

**✅ CHECKPOINT:** All initial projects registered and readable on-chain.

---

## Phase 3 — Backend Configuration

### 3.1 Environment Variables

Create `backend/.env` with Mainnet values:

```env
# ── Network ──────────────────────────────────────────────────
PORT=4000
NODE_ENV=production
STELLAR_NETWORK=mainnet
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://soroban.stellar.org
CONTRACT_ID=<CONTRACT_ID_FROM_PHASE_1>

# ── Security ─────────────────────────────────────────────────
ALLOWED_ORIGINS=https://your-production-domain.com
ADMIN_API_KEY=<GENERATE: openssl rand -hex 32>
JWT_SECRET=<GENERATE: openssl rand -base64 64>
WEBHOOK_SIGNING_SECRET=<GENERATE: openssl rand -hex 32>
METRICS_BEARER_TOKEN=<GENERATE: openssl rand -hex 32>

# ── Database ─────────────────────────────────────────────────
DATABASE_URL=postgres://user:password@host:5432/stellar_indigopay
DB_POOL_MAX=20

# ── APIs (optional but recommended) ──────────────────────────
ANTHROPIC_API_KEY=sk-ant-...        # AI impact summaries
SENTRY_DSN=https://...               # Error tracking
RESEND_API_KEY=re_...                # Email (digests, receipts)
RECEIPT_SIGNING_KEY=S...             # Stellar secret for receipt signing

# ── CO₂ Verification (optional) ──────────────────────────────
CO2_VERIFIER_GFW_API_KEY=...         # Global Forest Watch API
```

**⚠️ CRITICAL:** `RECEIPT_SIGNING_KEY` must be a Mainnet Stellar secret key (starts with `S`), NOT a testnet key.

### 3.2 Fix Hardcoded Testnet References

The `backend/src/services/receiptGenerator.js` has a hardcoded testnet URL at line 26. Update it:

**Before (line 26):**
```js
"Verify on Stellar Expert: https://stellar.expert/explorer/testnet/tx/" + donation.transaction_hash,
```

**After:**
```js
"Verify on Stellar Expert: https://stellar.expert/explorer/" +
  (process.env.STELLAR_NETWORK === "mainnet" ? "public" : "testnet") +
  "/tx/" + donation.transaction_hash,
```

### 3.3 Run Database Migrations

```bash
cd backend
npm run migrate
```

### 3.4 Seed Production Data

Update `backend/src/services/store.js` seed data to use Mainnet project IDs that match the on-chain registered projects. Ensure `seedProjects` entries use:

- Real Mainnet wallet addresses for each project
- The same `project_id` values used in `register_project` on-chain
- Verified CO₂ rates

### 3.5 Start and Verify Backend

```bash
cd backend
npm run dev
```

Verify:
```bash
# Health check
curl http://localhost:4000/api/health

# Readiness check (validates DB + Horizon + Soroban RPC)
curl http://localhost:4000/api/readyz

# Swagger docs
curl http://localhost:4000/api/docs

# Metrics (requires bearer token)
curl -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:4000/metrics
```

**✅ CHECKPOINT:** Backend running, connected to Mainnet Horizon, contract readable.

---

## Phase 4 — Frontend Configuration

### 4.1 Environment Variables

Create `frontend/.env.local` with Mainnet values:

```env
# ── Network ──────────────────────────────────────────────────
NEXT_PUBLIC_STELLAR_NETWORK=mainnet
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban.stellar.org
NEXT_PUBLIC_API_URL=https://your-production-api.example.com
NEXT_PUBLIC_CONTRACT_ID=<CONTRACT_ID_FROM_PHASE_1>

# ── USDC (Mainnet) ───────────────────────────────────────────
NEXT_PUBLIC_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# ── Optional ─────────────────────────────────────────────────
NEXT_PUBLIC_SENTRY_DSN=https://...
```

**Mainnet USDC Issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (official Circle USDC on Stellar)

### 4.2 Verify Network-Aware Code

The frontend already reads `NEXT_PUBLIC_STELLAR_NETWORK` in:
- `frontend/lib/stellar.ts` — `NETWORK`, `HORIZON_URL`, `SOROBAN_RPC_URL`
- `frontend/lib/WalletProvider.tsx` — wallet network detection
- `frontend/components/Navbar.tsx` — network badge display
- `frontend/components/DonateForm.tsx` — Stellar Expert explorer link

No code changes needed — the env vars drive everything.

### 4.3 Build and Test

```bash
cd frontend
npm run build
npm run dev
```

Verify:
1. Open `http://localhost:3000`
2. Connect Freighter (switched to Mainnet)
3. Browse projects — should show the 3 registered projects
4. Verify the navbar shows "Mainnet" badge (not "Testnet")
5. **Do NOT donate yet** — wait for full verification (Phase 5)

**✅ CHECKPOINT:** Frontend serving, connected to Mainnet, projects visible.

---

## Phase 5 — End-to-End Verification

### 5.1 Read-Only Verification

Test every read-only contract function from the frontend:

| Function | What to check |
|---|---|
| `get_project("amazon-reforestation")` | Returns correct name, wallet, CO₂ rate |
| `get_project_count()` | Returns ≥ 3 |
| `get_global_stats()` | All counters at 0 (no donations yet) |
| `get_admin_set()` | Returns deployer address |
| `get_global_total()` | Returns 0 |
| `get_global_co2()` | Returns 0 |

### 5.2 Test Donation (Minimal Amount)

**⚠️ This uses real XLM. Use a minimal amount (0.5–1 XLM).**

1. Fund a Freighter Mainnet wallet with ~5 XLM
2. Connect to the frontend
3. Donate 0.5 XLM to "Amazon Reforestation"
4. Verify:
   - Transaction succeeds in Freighter
   - Transaction appears on Stellar Expert (Mainnet!)
   - Donation appears in the frontend dashboard
   - `get_global_total()` increments by 0.5 XLM (5,000,000 stroops)
   - `get_donor_stats(your_address)` returns the correct badge

### 5.3 Verify Receipt Generation

After the test donation, request a tax receipt:
- Confirm the receipt PDF shows the Mainnet explorer URL, not testnet
- Verify the receipt signature can be validated

### 5.4 Verify Event Streaming

Check the backend is receiving Soroban events:
```bash
curl http://localhost:4000/api/donations/recent
```

**✅ CHECKPOINT:** Full donation flow works end-to-end on Mainnet.

---

## Phase 6 — Infrastructure & Kubernetes

### 6.1 Update ConfigMap

Update `k8s/configmap.yaml` for Mainnet:

```yaml
data:
  NODE_ENV: "production"
  STELLAR_NETWORK: "mainnet"                          # ← changed
  HORIZON_URL: "https://horizon.stellar.org"           # ← changed
  ALLOWED_ORIGINS: "https://your-production-domain.com"
  CONTRACT_ID: "<CONTRACT_ID>"                         # ← set
  NEXT_PUBLIC_STELLAR_NETWORK: "mainnet"               # ← changed
  NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org"# ← changed
  NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban.stellar.org" # ← changed
  NEXT_PUBLIC_CONTRACT_ID: "<CONTRACT_ID>"             # ← set
  NEXT_PUBLIC_USDC_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
```

### 6.2 Create Production Secrets

```bash
# Create from template
cp k8s/secret.example.yaml k8s/secret.yaml

# Fill in all values (use real credentials, NOT placeholders)
# k8s/secret.yaml is gitignored — it will NOT be committed
```

Or use External Secrets Operator (recommended for production):
- Configure `k8s/external-secret.yaml` with your provider (AWS/GCP/Vault)
- Store secrets in your secret manager
- See `docs/external-secrets.md` for full setup

### 6.3 Update Helm Values

Create `helm/indigopay/values-prod.yaml`:

```yaml
config:
  stellarNetwork: mainnet
  horizonUrl: https://horizon.stellar.org
  sorobanRpcUrl: https://soroban.stellar.org
  contractId: "<CONTRACT_ID>"
  usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10

pdb:
  enabled: true
  minAvailable: 1

ingress:
  host: your-production-domain.com
  className: nginx
```

### 6.4 Deploy Infrastructure

```bash
# Apply namespace
kubectl apply -f k8s/namespace.yaml

# Apply secrets
kubectl apply -f k8s/secret.yaml

# Apply config
kubectl apply -f k8s/configmap.yaml

# Deploy with Helm
helm install stellar-indigopay helm/indigopay/ -f values-prod.yaml

# Or with raw k8s
kubectl apply -f k8s/
```

### 6.5 Post-Deploy Verification

```bash
# Check pods
kubectl get pods -n stellar-indigopay

# Check services
kubectl get svc -n stellar-indigopay

# Check ingress
kubectl get ingress -n stellar-indigopay

# Run migrations
kubectl exec -it deployment/backend -n stellar-indigopay -- npm run migrate

# Health check
kubectl exec -it deployment/backend -n stellar-indigopay -- \
  curl -s http://localhost:4000/api/health
```

**✅ CHECKPOINT:** Production infrastructure running, ingress serving HTTPS.

---

## Phase 7 — Monitoring & Alerts

### 7.1 Configure Prometheus

Deploy the monitoring stack:
```bash
docker compose -f monitoring/docker-compose.monitoring.yml up -d
```

Or wire into your existing Prometheus:
- Scrape target: `backend-svc.stellar-indigopay.svc.cluster.local:4000/metrics`
- Bearer token auth (use `METRICS_BEARER_TOKEN` from secrets)

### 7.2 Verify Alert Rules

Confirm these Mainnet-specific alerts are configured:

| Alert | What it catches |
|---|---|
| `Backend5xxHigh` | Production error spike |
| `DBPoolWaitHigh` | Database connection exhaustion |
| `ContractCallFailure` | Soroban RPC errors |
| `BackupMissed` | Database backup failure |
| `RestoreDrillFailed` | Monthly restore test failure |

### 7.3 Set Up Uptime Monitoring

Configure an external uptime monitor (e.g., Better Uptime, Pingdom) to poll:
- `GET https://your-domain.com/api/health` — every 60s
- `GET https://your-domain.com/api/readyz` — every 300s

### 7.4 Configure Database Backups

```bash
# Manual first backup
./scripts/backup-db.sh

# The nightly GitHub Action (database-backup.yml) should be pointed
# at your production database. Update the workflow's env vars.
```

**✅ CHECKPOINT:** Monitoring, alerting, and backups active.

---

## Phase 8 — Security Hardening

### 8.1 Migrate to Multi-Sig Admin

After confirming everything works, set up M-of-N admin:

```bash
# Add admin 2
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- add_admin \
  --signers "[\"$ADMIN_KEY_1\"]" \
  --new_admin "$ADMIN_KEY_2"

# Add admin 3
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- add_admin \
  --signers "[\"$ADMIN_KEY_1\"]" \
  --new_admin "$ADMIN_KEY_3"

# Set threshold to 2-of-3
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source mainnet-deployer \
  --network mainnet \
  -- update_threshold \
  --signers "[\"$ADMIN_KEY_1\"]" \
  --new_threshold 2
```

Verify:
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  -- get_admin_set
# → Should show [ADMIN_1, ADMIN_2, ADMIN_3]
```

### 8.2 Verify Timelock Works

Test the 48h upgrade timelock (send a harmless proposal, cancel it):

```bash
# Propose (any valid 32-byte hash — this is a test)
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --signers "[\"$ADMIN_KEY_1\",\"$ADMIN_KEY_2\"]" \
  --network mainnet \
  -- propose_upgrade \
  --new_wasm_hash "0000000000000000000000000000000000000000000000000000000000000000"

# Cancel immediately
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --signers "[\"$ADMIN_KEY_1\",\"$ADMIN_KEY_2\"]" \
  --network mainnet \
  -- cancel_upgrade
```

### 8.3 Verify Pause Works

```bash
# Test contract pause (requires M-of-N)
# Wait at least until you've verified this with your team
# DO NOT leave paused for more than a few minutes
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --signers "[\"$ADMIN_KEY_1\",\"$ADMIN_KEY_2\"]" \
  --network mainnet \
  -- pause_contract

# Verify paused
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  -- is_contract_paused
# → true

# Unpause
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --signers "[\"$ADMIN_KEY_1\",\"$ADMIN_KEY_2\"]" \
  --network mainnet \
  -- unpause_contract
```

### 8.4 Security Checklist

- [ ] Multi-sig admin configured (2-of-3 minimum)
- [ ] Deployer seed stored in hardware wallet or HSM
- [ ] Admin key 2 stored separately from admin key 1 (different physical locations)
- [ ] Admin key 3 stored separately from keys 1 and 2
- [ ] Contract pause tested and verified
- [ ] Upgrade timelock tested (48h window confirmed)
- [ ] All backend secrets rotated from dev values
- [ ] CORS origins restricted to production domain(s)
- [ ] Rate limiting enabled on all endpoints
- [ ] Metrics endpoint behind bearer token auth
- [ ] Admin endpoints behind JWT + API key auth
- [ ] Database backups running and tested (monthly restore drill)
- [ ] Gitleaks scan clean (no secrets in repo)
- [ ] `.env` files NOT committed to git

**✅ CHECKPOINT:** Platform is production-hardened.

---

## Phase 9 — Launch Communications

### 9.1 Update Documentation

- [ ] Update `README.md` with Mainnet contract ID and explorer link
- [ ] Add `MAINNET_CONTRACT_ID=<id>` to `docs/contract-integration.md`
- [ ] Update Swagger/OpenAPI docs with production URL
- [ ] Add mainnet deployment badge to README

### 9.2 Notify Stakeholders

- [ ] Telegram community announcement
- [ ] Update project owners with their on-chain project IDs
- [ ] Notify API partners of production endpoint
- [ ] Update Drips Wave application with mainnet contract ID (if applying)
- [ ] Update GrantFox campaign with mainnet links (if active)

### 9.3 Update GitHub

```bash
# Tag the mainnet release
git tag -a v2.3.0-mainnet -m "Mainnet deployment: contract $CONTRACT_ID"
git push origin v2.3.0-mainnet
```

---

## Emergency Procedures

### If Admin Key is Compromised

1. **Immediately:** Remaining admins call `remove_admin` to revoke the compromised key
2. **If only 1 admin remains:** Call `add_admin` to add a replacement, then `remove_admin` the compromised one
3. **If threshold can't be met:** Deploy a new contract (this is the nuclear option — contract data is not transferable)

### If Contract Needs Emergency Pause

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --signers "[\"$ADMIN_KEY_1\",\"$ADMIN_KEY_2\"]" \
  --network mainnet \
  -- pause_contract
```

This stops ALL state-mutating functions (donations, registrations, NFT minting, governance). Read-only functions continue working.

### If Contract Upgrade is Needed

1. Build new WASM with backward-compatible storage layout
2. `propose_upgrade` with new WASM hash
3. **Wait 48 hours** (community review window)
4. `execute_upgrade` (permissionless — anyone can call)
5. Or `cancel_upgrade` if issues found during review

Full upgrade docs: `contracts/indigopay-contract/UPGRADE.md`

---

## Appendix A: Mainnet RPC Endpoints

| Service | Mainnet URL |
|---|---|
| Horizon API | `https://horizon.stellar.org` |
| Soroban RPC | `https://soroban.stellar.org` |
| Stellar Expert | `https://stellar.expert/explorer/public` |
| Friendbot | ❌ Not available on Mainnet |

## Appendix B: Key Differences from Testnet

| Concern | Testnet | Mainnet |
|---|---|---|
| XLM value | Free (Friendbot) | Real money (~$0.10/XLM) |
| Contract deployment | Reversible | **IRREVERSIBLE** — contract ID is permanent |
| Admin key compromise | Redeploy | 48h timelock is your only defense |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| USDC issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| Explorer URL | `stellar.expert/explorer/testnet` | `stellar.expert/explorer/public` |
| Wallet | Freighter (Testnet mode) | Freighter (Mainnet mode) |

## Appendix C: Quick Reference Card

```bash
# Deploy
./scripts/deploy-contract.sh mainnet mainnet-deployer

# Initialize (single admin)
stellar contract invoke --id $CONTRACT_ID --source mainnet-deployer --network mainnet \
  -- initialize --admins "[\"$(stellar keys address mainnet-deployer)\"]" --threshold 1

# Register project
stellar contract invoke --id $CONTRACT_ID --source mainnet-deployer --network mainnet \
  -- register_project --admin $ADMIN --project_id "id" --name "Name" --wallet G... --co2_per_xlm 8500

# Read
stellar contract invoke --id $CONTRACT_ID --network mainnet -- get_global_stats

# Pause (emergency)
stellar contract invoke --id $CONTRACT_ID --signers "[\"$A1\",\"$A2\"]" --network mainnet \
  -- pause_contract

# Unpause
stellar contract invoke --id $CONTRACT_ID --signers "[\"$A1\",\"$A2\"]" --network mainnet \
  -- unpause_contract
```

---

*Last updated: August 2026 · For the v2.3 Mainnet Launch*
