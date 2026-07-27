<div align="center">

# ✦ Stellar-IndigoPay

### Fund the planet. One XLM at a time.

[![MIT License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-6366F1.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-818CF8.svg)](CODE_OF_CONDUCT.md)
[![CI](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/ci.yml/badge.svg)](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/ci.yml)
[![Contracts CI](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/contracts.yml/badge.svg?branch=main)](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/contracts.yml)
[![Release](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/release.yml/badge.svg)](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/actions/workflows/release.yml)

[![Stellar](https://img.shields.io/badge/Stellar-Powered-6366F1?logo=stellar)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Soroban-Contracts-7C3AED)](https://soroban.stellar.org)
[![Node 20](https://img.shields.io/badge/Node-20%20LTS-339933?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev)
[![Next.js](https://img.shields.io/badge/Next.js-14-000000?logo=next.js)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://docker.com)
[![Rust](https://img.shields.io/badge/Rust-WASM-DEA584?logo=rust)](https://rust-lang.org)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-Deployed-326CE5?logo=kubernetes)](https://kubernetes.io)
[![Expo](https://img.shields.io/badge/Expo-Android%20%2B%20iOS-000020?logo=expo)](https://expo.dev)
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Chat-26A5E4?logo=telegram)](https://t.me/StellarIndigoPay)

[**🌐 Web App**](https://stellarindigopay.com) · [**📱 Mobile App**](https://expo.dev/) · [**🧩 Chrome Extension**](https://chrome.google.com/webstore/) · [**📚 Docs**](docs/README.md) · [**💬 Telegram**](https://t.me/StellarIndigoPay) · [**🚀 Quick Start**](#-quick-start)

</div>

---

## ✨ What is Stellar-IndigoPay?

Stellar-IndigoPay is an **open-source climate donation platform** built on the Stellar network. Donors give XLM (and USDC) directly to verified environmental projects — funds never touch a custodian. Every donation is recorded on-chain via a [Soroban](https://soroban.stellar.org) smart contract, so total impact, donor reputation, and CO₂ offsets are **publicly auditable** by anyone, in any language, on any device.

The same platform ships as:

| Surface                  | What it is                                                                      | Built with                                 |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 🌐 **Web app**           | Full-featured donor dashboard, project browse, leaderboard, AI impact summaries | Next.js 14 · React · TypeScript · Tailwind |
| 📱 **Mobile app**        | On-the-go donations, QR-scan-to-give, biometric auth, push receipts             | React Native · Expo · expo-router          |
| 🧩 **Browser extension** | Detect Stellar addresses on any page, donate in one click                       | Manifest V3 · Webpack                      |
| ⛓️ **Soroban contracts** | On-chain donation ledger, badges, governance, upgrades, NFT minting             | Rust 1.91 · WASM `wasm32v1-none`           |
| 🛠 **Backend API**        | Metadata, leaderboard, webhooks, AI summaries, admin                            | Node.js 20 · Express · Postgres · pg-boss  |

---

## 🎯 Why Stellar-IndigoPay?

- 🔐 **Custody-minimised** — XLM goes directly from donor wallet to project wallet. The platform never holds funds.
- 📜 **On-chain transparency** — Soroban is the single source of truth. Anyone can read `get_project()`, `get_donor_stats()`, `get_global_total()` without trusting us.
- 🪪 **No accounts** — your Stellar keypair is your identity. No email, no password, no recovery phone.
- 🏷 **Reputation you own** — Impact badges (🌱 Seedling, 🌳 Tree, 🌲 Forest, 🌍 Earth Guardian) and Impact NFTs are wallet-bound and travel with you across dApps.
- 💱 **Multi-currency** — Donate in XLM or USDC. USDC amounts are converted via a configurable on-chain price oracle.
- 🗳 **Community governance** — Badge holders vote to verify new projects. On-chain proposals with configurable voting windows.
- 🤖 **AI impact summaries** — every project gets a plain-language explainer of where donations go, generated and cached server-side.
- 🔔 **Webhooks for partners** — signed, retried, dead-lettered milestone events for any project that wants them.
- 🛰 **Production-grade ops** — Helm, ArgoCD, Prometheus, Alertmanager with PagerDuty/Slack routing, monthly restore drills, SBOM + cosign signing.

---

## 🚀 Quick start

You can be donating on testnet in **under five minutes**.

### 1. Prerequisites

| Tool                                         | Version    | Why                                                                             |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Node.js                                      | **20 LTS** | Backend + frontend + mobile scripts                                             |
| npm                                          | 10+        | Package manager                                                                 |
| Docker + Docker Compose                      | Latest     | One-command dev environment                                                     |
| Freighter Wallet                             | Latest     | Stellar browser wallet (or [Freighter Mobile](https://freighter.app) on phones) |
| _(optional)_ Rust                            | 1.91+      | Only if you want to build the Soroban contracts                                 |

### 2. Clone & bootstrap

```bash
git clone https://github.com/Stellar-IndigoPay/Stellar-IndigoPay.git
cd Stellar-IndigoPay
chmod +x scripts/setup-dev.sh
./scripts/setup-dev.sh
```

The setup script installs Node deps for the backend, frontend, mobile, and extension and verifies the toolchain.

### 3. Run the full stack with Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

| Service             | URL                                          |
| ------------------- | -------------------------------------------- |
| 🖥 Frontend          | <http://localhost:3000>                      |
| 🛠 Backend API       | <http://localhost:4000>                      |
| 📜 Swagger UI       | <http://localhost:4000/api/docs>             |
| ❤️ Health           | <http://localhost:4000/api/health>           |
| 🗄 Postgres          | `localhost:5432` (`indigopay` / `indigopay`) |
| 📦 Redis (optional) | `localhost:6379`                             |

The `docker-compose.dev.yml` override mounts source code into the containers and enables hot-reload for both Next.js and Express. Source edits refresh in seconds.

### 4. Fund a testnet wallet

1. Install [Freighter](https://freighter.app) and switch it to **Testnet**
2. Copy your public key (starts with `G…`)
3. Visit `https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>` and you'll get 10 000 test XLM in a few seconds

### 5. Donate

- Open <http://localhost:3000>
- Click **Connect Wallet** → approve in Freighter
- Pick a project → enter an amount → sign the transaction in Freighter
- Refresh the dashboard — your donation is recorded both on-chain and in the backend

That's it. No account creation, no email verification, no KYC.

---

## 🏗 Architecture

```
                        ┌──────────────────────────────────┐
                        │        Donor (Freighter)         │
                        └─────┬───────────────┬────────────┘
                              │               │
              sign locally    │               │   scan QR
                              ▼               ▼
                ┌──────────────────────┐  ┌────────────────────┐
                │   Web (Next.js)      │  │  Mobile (Expo)     │
                │   Extension (MV3)    │  │                    │
                └────────┬─────────────┘  └────────┬───────────┘
                         │ REST + WebSocket        │
                         ▼                         ▼
              ┌─────────────────────────────────────────────┐
              │   Node.js Backend (Express, Postgres)       │
              │   • Project metadata & leaderboard          │
              │   • Donation record (durable, idempotent)   │
              │   • Webhook delivery (pg-boss + DLQ)        │
              │   • AI impact summaries (Anthropic)         │
              │   • Admin + audit log                       │
              │   • Sentry traces, Prometheus metrics        │
              └──┬──────────────────┬──────────────┬───────┘
                 │                  │              │
                 ▼                  ▼              ▼
        ┌────────────────┐  ┌────────────┐  ┌──────────────┐
        │  Postgres      │  │  Redis     │  │  Horizon /   │
        │  (durable      │  │  (cache)   │  │  Soroban RPC │
        │   ledger)      │  │            │  │  (indexer)   │
        └────────────────┘  └────────────┘  └──────┬───────┘
                                                   │
                                                   ▼
                                       ┌────────────────────────┐
                                       │  Soroban               │
                                       │  IndigoPay Contract    │
                                       │  (Rust / WASM)         │
                                       │  Source of truth       │
                                       └────────────────────────┘
```

**Key design choices** (full rationale in [`docs/architecture.md`](docs/architecture.md)):

- **Direct-to-project payments** — funds flow donor → project wallet. The contract records the event; it never custodies funds.
- **Backend is optional** — if the API is down, donations still succeed; you just can't see the leaderboard.
- **Soroban is the source of truth** — the contract exposes 20+ read functions; the backend is a queryable cache.
- **Wallet-as-identity** — auth is `require_auth()` on the Stellar keypair. No password reset, no email enumeration.
- **Defense in depth** — NetworkPolicies (default-deny), `PodDisruptionBudget`, `HorizontalPodAutoscaler`, External Secrets, SBOM + Trivy + cosign, monthly restore drills.

---

## 🌟 Features in depth

### 🌐 Web app (`frontend/`)

- Browse verified projects with category, location, CO₂ offset, leaderboard rank
- Connect Freighter; sign donations locally — keys never leave the wallet
- Personal dashboard: lifetime donated, current badge, recent donations
- Project pages: campaign progress, milestones, ratings, **AI-generated impact summary**
- Real-time donation ticker + impact world map
- **Internationalisation**: English, French, Spanish ([`frontend/lib/i18n.tsx`](frontend/lib/i18n.tsx))
- Monthly giving setup with pause / cancel ([`frontend/lib/monthlyGiving.ts`](frontend/lib/monthlyGiving.ts))
- Project comparison + wishlist + autocomplete
- Wallet address QR generator, project QR donation

### 📱 Mobile app (`mobile/`)

- iOS + Android via a single React Native codebase
- **`expo-router`** file-based navigation
- **Biometric auth** for sensitive flows ([`mobile/hooks/useBiometricAuth.ts`](mobile/hooks/useBiometricAuth.ts))
- **Secure store** for cached secrets ([`mobile/lib/secureStore.ts`](mobile/lib/secureStore.ts))
- **QR donation** with camera ([`mobile/app/scan.tsx`](mobile/app/scan.tsx))
- Deep links for mobile wallets (`freighter://tx?xdr=…`)
- Push notifications for donation receipts and project updates
- Offline support with AsyncStorage-backed cache

### 🧩 Browser extension (`extension/`)

- **Manifest V3** for Chrome and Firefox ([`extension/manifest.json`](extension/manifest.json), [`extension/manifest.firefox.json`](extension/manifest.firefox.json))
- Detects Stellar addresses (matching `^G[A-Z0-9]{55}$`) on any web page
- Click the popup to send a donation to the detected address

### ⛓️ Soroban contracts (`contracts/`)

| Capability                | Entry points                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project registry**      | `register_project`, `batch_register_projects`, `update_project_co2_rate`, `pause_project`, `resume_project`, `deactivate_project`, `deactivate_all_projects`                                                                             |
| **Donations**             | `donate(token, donor, project_id, amount, msg_hash)`, `donate_usdc(…)` with on-chain price oracle                                                                                                                              |
| **Reputation**            | `get_donor_stats`, `get_badge`, tier calculation (`None` / `Seedling` / `Tree` / `Forest` / `EarthGuardian`)                                                                                                                             |
| **NFTs**                  | `mint_impact_nft(donor, tier)`, `mint_project_nft(donor, project_id)`                                                                                                                                                                    |
| **Governance**            | `create_proposal`, `vote_verify_project`, `resolve_proposal`, `veto_proposal` (gated by `≥ Seedling` badge)                                                                                                                              |
| **Trust model (Phase A)** | `transfer_admin` → `accept_admin` (two-step), `pause_contract` / `unpause_contract`, `propose_upgrade` → 48h timelock → `execute_upgrade`                                                                                                |
| **Multi-currency**        | `set_usdc_token`, `set_oracle`, `get_usdc_token`, `get_oracle` — donate in XLM or USDC with oracle-backed conversion                                                                                                                    |
| **Read**                  | `get_project`, `get_global_total`, `get_global_co2`, `get_global_stats`, `get_donation_count`, `get_project_count`, `get_donation_record`, `get_pending_admin`, `is_contract_paused`, `get_pending_upgrade`, `get_last_executed_upgrade` |

Also includes an **escrow contract** (`contracts/escrow-contract/`) for milestone-based project payouts with dispute resolution.

Full details: [`contracts/indigopay-contract/README.md`](contracts/indigopay-contract/README.md) · [`contracts/indigopay-contract/SECURITY.md`](contracts/indigopay-contract/SECURITY.md) · [`contracts/indigopay-contract/UPGRADE.md`](contracts/indigopay-contract/UPGRADE.md)

### 🛠 Backend API (`backend/`)

- Express 5 + Node 20 + zod env validation
- **Postgres** for durable storage (donations, profiles, projects, jobs, ratings, updates, subscriptions, webhooks, AI summaries)
- **pg-boss** for durable background jobs (webhook delivery, AI summaries, profile enrichment, digests)
- **Webhook delivery**: `webhookQueue` worker with 6-attempt backoff (30s → 2m → 10m → 30m → 2h → 6h), DLQ, GitHub-style `t=…,v1=…` HMAC-SHA256 signing, 5-min replay window, idempotency by event id ([`docs/webhook-receiver.md`](docs/webhook-receiver.md))
- **OpenAPI 3.0.3** spec served as Swagger UI at `/api/docs` ([`docs/api/openapi.yaml`](docs/api/openapi.yaml))
- **Sentry** traces + **Prometheus** metrics (`/metrics`, bearer-token auth in prod)
- **Socket.IO** for real-time donation ticker
- **Admin console** with JWT + refresh tokens, audit log, project status changes
- **zod**-validated request payloads, **express-rate-limit** + **csurf**
- **Pino** structured logging, `X-Request-Id` correlation on every request
- 32+ Jest cases covering metrics, lifecycle, requestId, health, and readiness
- Sentry + Prometheus + webhook + indexer **graceful shutdown** wired through a lifecycle service

### 🛰 Observability (`monitoring/`)

- **Prometheus** scrapes backend, indexer, and pg-boss job metrics
- **Grafana** dashboards with platform health, donation flow, AI cost, webhook health
- **Alertmanager** with **PagerDuty** + **Slack** + business-hours routing and inhibition rules
- Alert rules: 5xx rate, p99 latency, DB pool wait, slow query p99, readiness failing, `BackupMissed`, `RestoreDrillFailed`
- Docker Compose stack ([`monitoring/docker-compose.monitoring.yml`](monitoring/docker-compose.monitoring.yml)) and Helm chart integration

### 🔒 Security posture

- Default-deny **NetworkPolicy** in the `indigopay` namespace, with explicit allow rules
- HPA (min 2, max 10) + PDB (`minAvailable: 1`) on backend and frontend
- **External Secrets** operator template ([`k8s/external-secret.yaml`](k8s/external-secret.yaml), [`docs/external-secrets.md`](docs/external-secrets.md))
- **SBOM** on every push, **Trivy** image scan (informational), **cosign** keyless signing on release tags
- **Gitleaks** secret scan with a curated allowlist ([`.gitleaks.toml`](.gitleaks.toml))
- Rate limit + CSRF + helmet + CSP + Sentry error capture
- Audit log of every admin action with actor, target, IP, and metadata

### 💥 Disaster recovery

- Nightly `pg_dump` to S3 / GCS, 30-day retention ([`.github/workflows/database-backup.yml`](.github/workflows/database-backup.yml))
- **Monthly restore drill** that spins up an ephemeral Postgres and asserts row counts ([`.github/workflows/restore-drill.yml`](.github/workflows/restore-drill.yml))
- Documented RTO / RPO, failure modes, and secret-compromise procedure ([`docs/disaster-recovery.md`](docs/disaster-recovery.md), [`docs/restore-runbook.md`](docs/restore-runbook.md))

---

## 🧪 Testing

| Layer           | Command                                                 | Notes                                                       |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Backend unit    | `cd backend && npm test`                                | Jest + supertest, in-memory Postgres via testcontainers     |
| Frontend unit   | `cd frontend && npm test`                               | Jest + Testing Library                                      |
| Frontend e2e    | `cd frontend && npm run test:e2e`                       | Playwright; accessibility checks via `@axe-core/playwright` |
| Contracts       | `cargo test --features testutils`                       | Rust unit + property-based fuzz (10 000+ iterations)        |
| Contracts build | `cargo build --workspace --target wasm32v1-none --release` | WASM artefacts in `target/`                              |
| DAST            | `.github/workflows/ci.yml` (ZAP baseline)               | OWASP ZAP baseline against the running frontend             |
| Load            | `k6 run scripts/load-test.js`                           | See SLOs in [`docs/performance.md`](docs/performance.md)    |
| Restore drill   | `.github/workflows/restore-drill.yml`                   | Monthly in CI                                               |

---

## 🚢 Deployment

| Environment           | Path                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes (raw YAML) | [`k8s/`](k8s/) — namespace, configmap, secret, postgres, backend, frontend, ingress, HPA, PDB, NetworkPolicies, ExternalSecret                                                                             |
| Helm chart            | [`helm/indigopay/`](helm/indigopay/) — chart-driven reconciliation, tested in CI with `helm lint` + `helm template`                                                                                        |
| GitOps                | [`gitops/argocd-application.yaml`](gitops/argocd-application.yaml) + [`gitops/argo-rollouts-canary.yaml`](gitops/argo-rollouts-canary.yaml) for progressive delivery with Prometheus success-rate analysis |
| Local dev             | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`                                                                                                                                        |
| CI test               | `docker compose -f docker-compose.test.yml up`                                                                                                                                                             |
| Mainnet launch        | [`docs/deployment-mainnet.md`](docs/deployment-mainnet.md)                                                                                                                                                 |

Container images are multi-stage (`builder` + `runner`), pinned to `node:20.18.1-alpine` LTS, built with `npm ci --omit=dev`, and signed with cosign on release tags.

---

## 📚 Documentation

The full doc tree is indexed in [`docs/README.md`](docs/README.md). Highlights:

- [**`docs/architecture.md`**](docs/architecture.md) — system overview, donation flow, design decisions
- [**`docs/getting-started.md`**](docs/getting-started.md) — five-minute first run
- [**`docs/contract-integration.md`**](docs/contract-integration.md) — partner SDK guide with TypeScript + Go + Python examples
- [**`docs/webhook-receiver.md`**](docs/webhook-receiver.md) — receiver guide for milestone events
- [**`docs/performance.md`**](docs/performance.md) — SLOs and k6 recipes
- [**`docs/DEPLOYMENT.md`**](docs/DEPLOYMENT.md) and [**`docs/deployment-mainnet.md`**](docs/deployment-mainnet.md)
- [**`docs/disaster-recovery.md`**](docs/disaster-recovery.md) and [**`docs/restore-runbook.md`**](docs/restore-runbook.md)
- [**`docs/external-secrets.md`**](docs/external-secrets.md)
- [**`docs/extension-build-process.md`**](docs/extension-build-process.md)
- [**`docs/zap-triage.md`**](docs/zap-triage.md) — DAST results workflow
- **`docs/backend/`** — auto-generated TypeDoc site for the backend service layer (run `npx typedoc` in `backend/` to generate)
- [**ADRs**](docs/adr/) — Stellar/Soroban vs EVM, direct-to-wallet vs custody, wallet-as-identity, CEI pattern

---

## 🤝 Contributing

We welcome contributions of any size. See [**`CONTRIBUTING.md`**](CONTRIBUTING.md) for the full guide, including Freighter setup, Friendbot funding, Docker hot-reload, the k6 perf gate, wallet integration guidelines, and the changelog policy.

Quick checklist for a good PR:

- [ ] Tests pass locally (`npm test` in the affected package)
- [ ] Lint passes (`npm run lint`)
- [ ] Type-check passes (`npm run type-check` for frontend / mobile)
- [ ] For backend API changes, the OpenAPI spec is updated and Swagger UI reflects it
- [ ] For contract changes, `cargo test --features testutils` passes and an entry is added to [`contracts/EVENTS.md`](contracts/EVENTS.md) for any new event
- [ ] CHANGELOG.md has a one-line entry under `[Unreleased]` in Keep-a-Changelog format
- [ ] No secrets in the diff (CI runs gitleaks)

This project is governed by the [**Contributor Covenant**](CODE_OF_CONDUCT.md).

---

## 🔐 Security

If you find a vulnerability, **please do not open a public issue.** Use [GitHub Security Advisories](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/security/advisories/new) or contact the maintainers privately. See [**`SECURITY.md`**](SECURITY.md) for the response SLA (acknowledgement within 48h, patch within 30d for critical issues).

---

## 🗺 Roadmap

| Release | Highlights | Status |
| ------- | ---------- | ------ |
| **v1.0** | Wallet connect, project browse, donations, leaderboard, Soroban ledger | ✅ Shipped |
| **v1.1** | Docker Compose, CI across all layers, unit + e2e tests | ✅ Shipped |
| **v1.2** | Verified projects: admin review, on-chain registration | ✅ Shipped |
| **v1.3** | Impact NFT badges (Seedling / Tree / Forest / Earth Guardian) | ✅ Shipped |
| **v1.4** | Community features (follow, comments, monthly digests, impact dashboard) | ✅ Shipped |
| **v1.5** | Impact dashboard: global map, real-time donation stream, project completion | ✅ Shipped |
| **v2.0** | Multi-currency: USDC alongside XLM with on-chain price oracle | ✅ Shipped |
| **v2.1** | DAO governance: badge-weighted voting on project verification, escrow contracts | ✅ Shipped |
| **v2.2** | (Planned) Cross-chain attestations, deeper DEX integration, mobile-first UX overhaul | 🚧 Planned |

Full backlog: [**`ROADMAP.md`**](ROADMAP.md).

---

## 📄 License

[MIT](LICENSE) © the Stellar IndigoPay contributors.

---

## 🌟 Acknowledgements

- [Stellar Development Foundation](https://stellar.org) for Soroban and Horizon
- [Freighter](https://freighter.app) for the wallet that makes this UX possible
- The [Soroban community](https://soroban.stellar.org/docs) for the smart-contract primitives
- [Anthropic](https://anthropic.com) for the AI model that powers impact summaries
- Every donor, project owner, and contributor who has made this platform what it is

<div align="center">

**🌱 Built with care by an open community. Every commit matters.**

</div>
