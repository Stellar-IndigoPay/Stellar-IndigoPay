# ✦ Stellar-IndigoPay — Documentation Index

Welcome to the Stellar-IndigoPay documentation. This index is the landing page
for everything in this directory. Pick the section that matches what you need.

> **Just want to try the app?** Jump to **[Getting Started](getting-started.md)**
> for a five-minute first run, or watch the **[Walkthrough](walkthrough.md)**
> for a guided tour of the donor flow.
>
> 💬 **Join the community:** [Telegram](https://t.me/StellarIndigoPay)

---

## Table of contents

- [For users](#for-users)
- [For developers](#for-developers)
  - [Architecture & system design](#architecture--system-design)
  - [Smart contracts](#smart-contracts)
  - [REST API & SDK](#rest-api--sdk)
  - [Architecture decision records](#architecture-decision-records)
- [For operators / SREs](#for-operators--sres)
  - [Deployment](#deployment)
  - [Observability & incident response](#observability--incident-response)
  - [Build & release](#build--release)
- [For contributors](#for-contributors)
- [Document map](#document-map)

---

## For users

| Document                                                      | What's in it                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **[Getting Started](getting-started.md)**                     | Prerequisites (Node 20+, Docker, Rust), funding a testnet wallet, your first donation, browsing the dashboard, verifying on-chain. |
| **[Walkthrough](walkthrough.md)**                             | ≈ 6-minute guided flow with screenshots and embedded demo.                                                                         |
| **[Contract Integration — FAQ](contract-integration.md#faq)** | Common questions for partners integrating with the Soroban contract.                                                               |

---

## For developers

### Architecture & system design

| Document                                         | What's in it                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[System Architecture](architecture.md)**       | ASCII diagrams of the platform, donation flow, key design decisions, security table. Start here.                                                       |
| **[Database Schema](database.md)**               | Postgres tables, indexes, FK relationships, and the migration workflow.                                                                                |
| **[Indexer](indexer.md)**                        | The Stellar Horizon stream → Postgres indexer, including shutdown wiring.                                                                              |
| **[Performance & Load Testing](performance.md)** | p50 / p95 / p99 targets, k6 invocation, threshold semantics, and the baseline table.                                                                   |
| **[CI / CD pipeline](../.github/workflows/)**    | Per-app workflows (`frontend.yml`, `extension.yml`, `mobile.yml`, `contracts.yml`), main CI (backend, helm, gitleaks, OpenAPI lint, ZAP), release, SBOM, and image scanning. |

### Smart contracts

| Document                                                                   | What's in it                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Contract Integration Guide](contract-integration.md)**                  | TypeScript client examples for `donate()` / `get_donor_stats()` / `get_badge()` / `get_project()` / `get_global_*()`, a complete partner Soroban contract, Go + Python verifier snippets, error table, stroops math, poll-with-backoff pattern, FAQ. |
| **[IndigoPay Contract README](../contracts/indigopay-contract/README.md)** | Entry points, storage layout, error catalog, dev-deploy walkthrough.                                                                                                                                                                                 |
| **[Security Model](../contracts/indigopay-contract/SECURITY.md)**          | Threat model, audit checklist, trust assumptions, what the contract does **not** protect against.                                                                                                                                                    |
| **[Upgrade Timelock](../contracts/indigopay-contract/UPGRADE.md)**         | 48-hour timelock, propose / execute / cancel, two-step admin transfer.                                                                                                                                                                               |
| **[CO₂ Oracle](../contracts/indigopay-contract/ORACLE.md)**                | Oracle architecture, freshness window, integration with milestone verification.                                                                                                                                                                      |
| **[Contract Events](../contracts/EVENTS.md)**                              | Every event emitted by the Soroban contracts, with payload schemas.                                                                                                                                                                                  |
| **[Soroban Developer Guide](../contracts/README.md)**                      | Building, testing, and deploying the contracts with the official Soroban toolchain.                                                                                                                                                                  |

### REST API & SDK

| Document                                          | What's in it                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[REST API Reference](api.md)**                  | Prose reference: version policy (`/api/v1` with a 308 legacy redirect), pagination, project object shape, donation recording, leaderboard, profile endpoints. |
| **[OpenAPI 3.0.3 Spec](api/openapi.yaml)**        | The canonical machine-readable spec. Rendered as Swagger UI at **`/api/docs`** in dev.                                                                        |
| **[Webhook Receiver Guide](webhook-receiver.md)** | Partner-side receiver: Node / Go / Flask examples, signature verification, replay window, idempotency, secret rotation.                                       |
| **[ZAP Triage Guide](zap-triage.md)**             | How to triage OWASP ZAP baseline scan results, with the project's `zap-false-positives.json` allowlist.                                                       |

### Architecture decision records

| ADR                                                                                                                                 | Decision                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [ADR-001 — Why Stellar Soroban over EVM](adr/ADR-001-why-stellar-soroban-over-evm.md)                                               | Latency, cost, native asset, and developer-experience rationale. |
| [ADR-002 — Why direct-to-wallet payments over platform custody](adr/ADR-002-why-direct-to-wallet-payments-over-platform-custody.md) | Trust minimization and reduced attack surface.                   |
| [ADR-003 — Wallet-as-identity authentication](adr/ADR-003-authentication-approach-wallet-as-identity.md)                            | No passwords, no email — the Stellar keypair is the identity.    |
| [ADR-004 — CEI pattern](adr/ADR-004-cei-pattern.md)                                                                                 | Checks-Effects-Interactions ordering in the Soroban contracts.   |

---

## For operators / SREs

### Deployment

| Document                                        | What's in it                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **[Deployment Guide](DEPLOYMENT.md)**           | Helm + raw k8s, ingress / TLS, post-deploy migrations, Soroban mainnet registration.                           |
| **[Mainnet Deployment](deployment-mainnet.md)** | Step-by-step Stellar Mainnet launch checklist, env files, admin identity, network passphrase, troubleshooting. |
| **[External Secrets](external-secrets.md)**     | external-secrets-operator install, IAM / IRSA / Workload Identity, switching providers (AWS / GCP / Vault).    |
| **[Helm Chart](../helm/indigopay/)**            | The chart, with `values.yaml` knobs for autoscaling, PDB, ingress, image, and resources.                       |
| **[Raw Kubernetes Manifests](../k8s/)**         | The unrendered YAML for clusters that don't use Helm.                                                          |

### Observability & incident response

| Document                                           | What's in it                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **[Disaster Recovery Plan](disaster-recovery.md)** | RTO / RPO table, failure modes, secret-compromise procedure, multi-region roadmap.                          |
| **[Postgres Restore Runbook](restore-runbook.md)** | Pre-flight → provision → cutover → post-restore → dry run. Exercised monthly by the restore-drill workflow. |
| **[Performance & Load Testing](performance.md)**   | SLO table and k6 recipes for verifying them.                                                                |
| **[Monitoring Stack](../monitoring/)               | Prometheus + Grafana + Alertmanager compose stack, alert rules, dashboards.                                 |
| **[ZAP Triage Guide](zap-triage.md)**              | Weekly DAST scan handling.                                                                                  |

### Build & release

| Document                                                                 | What's in it                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **[Extension Build Process](extension-build-process.md)**                | Chrome vs Firefox manifest, packaging, store submission, troubleshooting. |
| **[Release workflow](../.github/workflows/release.yml)**                 | semantic-release on `main` when a commit message contains `[release]`.    |
| **[Database backup workflow](../.github/workflows/database-backup.yml)** | Nightly `pg_dump` to S3 / GCS, 30-day retention, manual dispatch.         |
| **[Restore drill workflow](../.github/workflows/restore-drill.yml)**     | Monthly exercise that pulls the latest backup and asserts row counts.     |

---

## For contributors

| Document                                     | What's in it                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Contributing Guide](../CONTRIBUTING.md)** | Repo setup, Freighter install, Friendbot funding, env files, Docker hot-reload, k6 perf gate, wallet guidelines, Sentry setup, changelog policy. |
| **[Roadmap](../ROADMAP.md)**                 | Where the project is heading.                                                                                                                    |
| **[Code of Conduct](../CODE_OF_CONDUCT.md)   | Community expectations.                                                                                                                          |
| **[Security Policy](../SECURITY.md)**        | How to report a vulnerability.                                                                                                                   |
| **[Changelog](../CHANGELOG.md)**             | Keep-a-Changelog-format release notes.                                                                                                           |
| **[Telegram Community](https://t.me/StellarIndigoPay)** | Chat with contributors, ask questions, and share ideas.                                                                           |

---

## Document map

A flat listing of every file in this directory so nothing is hidden:

```
docs/
├── README.md                  ← you are here
├── architecture.md            ← system overview, donation flow, design decisions
├── getting-started.md         ← five-minute first run
├── walkthrough.md             ← guided demo
├── performance.md             ← SLOs + k6 recipes
├── database.md                ← Postgres schema + migrations
├── indexer.md                 ← Horizon stream indexer
├── contract-integration.md    ← partner SDK guide
├── api.md                     ← REST API prose reference
├── api/openapi.yaml           ← canonical OpenAPI 3.0.3 spec
├── webhook-receiver.md        ← partner webhook guide
├── zap-triage.md              ← OWASP ZAP results workflow
├── extension-build-process.md ← browser extension packaging
├── DEPLOYMENT.md              ← Helm / k8s deployment
├── deployment-mainnet.md      ← Stellar Mainnet launch
├── external-secrets.md        ← external-secrets-operator
├── disaster-recovery.md       ← DR plan + RTO / RPO
├── restore-runbook.md         ← Postgres restore procedure
├── adr/                       ← architecture decision records
│   ├── ADR-001-why-stellar-soroban-over-evm.md
│   ├── ADR-002-why-direct-to-wallet-payments-over-platform-custody.md
│   ├── ADR-003-authentication-approach-wallet-as-identity.md
│   └── ADR-004-cei-pattern.md
└── backend/                   ← auto-generated TypeDoc site (build with `npm run docs`)
```

---

_If you find a missing link, broken example, or unclear section, please open
an issue or PR against this directory — the docs are a first-class part of
the codebase._
