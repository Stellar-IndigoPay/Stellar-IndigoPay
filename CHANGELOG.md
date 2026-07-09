# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Webhook reliability** — `webhookQueue` worker backed by pg-boss with a
  6-attempt exponential backoff (30s → 2m → 10m → 30m → 2h → 6h) and a
  dead-letter table (`webhook_dlq`) for permanent failures. Replaces the
  old fire-and-forget `fetch` with a durable retry / DLQ pipeline.
- **Webhook signing** — `webhookSign` helper implementing GitHub-style
  `t=…,v1=…` HMAC-SHA256 with a 5-minute replay window and constant-time
  comparison. Idempotency enforced by `INSERT … ON CONFLICT DO UPDATE
  RETURNING id, (xmax=0) AS inserted` on `webhook_deliveries`.
- **Webhook Prometheus metrics** — `webhook_deliveries_total`,
  `webhook_delivery_attempts_total`, `webhook_delivery_duration_seconds`,
  plus `ai_summary_tokens_total`, `ai_summary_cost_usd_total`,
  `ai_summary_latency_seconds`, and `ai_summary_outcomes_total`.
- New database tables: `webhook_deliveries`, `webhook_dlq`,
  `prompt_versions`, and `ai_summary_calls`.
- **Soroban trust model** — 48h upgrade timelock
  (`propose_upgrade` / `execute_upgrade` / `cancel`), contract-level pause
  (`pause_contract` / `unpause_contract`), and two-step admin transfer
  (`transfer_admin` / `accept_admin` / `cancel`). Full threat model
  documented in `contracts/indigopay-contract/SECURITY.md` and
  `UPGRADE.md`.
- Backend observability env vars documented in `.env.example`
  (`METRICS_BEARER_TOKEN`, `INDEXER_*`, `SENTRY_*`, etc.).
- 32 Jest cases covering metrics, lifecycle, requestId, health, and
  readiness in `backend/__tests__/`.

### Changed

- `backend/src/routes/webhook.js` defers delivery to `webhookQueue`;
  the public route surface is preserved so existing partners keep working.
- `backend/src/server.js` wires `webhookQueue.start` into boot and
  registers a lifecycle shutdown hook to drain in-flight jobs on SIGTERM.
- Soroban contracts: extracted a shared `require_admin` helper and
  unified the admin panic message across all admin-only entry points.
- `docs/README.md` indexes every document by audience (users, developers,
  operators, contributors).

### Fixed

- `webhook.js` retry scheduler now uses `boss.send(..., { startAfter })`
  instead of relying on the implicit loop. A deduped enqueue returns the
  existing `deliveryId` rather than silently re-creating a row.
- `backend/src/services/indexerService` exposes a `stop()` method so the
  Stellar Horizon stream is closed cleanly on SIGTERM.

- **NetworkPolicies** — default-deny for the `indigopay` namespace plus
  explicit allow policies for ingress → backend, backend → postgres +
  kube-dns, backend → redis, backend → Stellar Horizon / Soroban RPC /
  Anthropic / Sentry, Prometheus → backend `/metrics`, and frontend →
  backend (the last one closes the default-deny gap for the Next.js client).
- **Autoscaling** — `HorizontalPodAutoscaler` for backend and frontend
  (min 2, max 10, CPU 70% / memory 80%) and `PodDisruptionBudget` with
  `minAvailable: 1` for both, mirrored in the Helm chart via
  `values.autoscaling` and `values.pdb`.
- **Helm chart** — new `_helpers.tpl` (`backendName`, `frontendName`,
  `commonLabels`) and `values.yaml` blocks for autoscaling and PDB so
  the chart actually renders end-to-end (`helm template` was previously
  broken by missing helpers).
- **Secrets management** — `k8s/secret.example.yaml` is the checked-in
  template; the real `k8s/secret.yaml` is gitignored;
  `.github/workflows/secrets-lint.yml` fails CI on placeholder leaks in
  `k8s/`, `helm/`, and `monitoring/`. The template was rewritten to use
  lint-safe `__LIKE_THIS__` markers so the lint does not trip on it.
- **External Secrets** — `ExternalSecret` + `SecretStore` templates for
  AWS Secrets Manager, an IRSA `ServiceAccount` stub, and full setup
  documentation (`docs/external-secrets.md`).

<!-- BACKFILL_INSERT -->

## [1.0.0] - 2025-01-01

### Added

- Wallet Connect via Freighter browser extension.
- Browse verified climate projects with impact metrics.
- Direct on-chain XLM donations to project wallets.
- Soroban smart contract for donation and CO₂ offset tracking.
- Donor leaderboard ranked by total XLM given.
- Project updates — organisations post progress updates to donors.
- CI/CD pipelines (lint, type-check, test, build, e2e, DAST).
- Docker Compose development environment with hot reload.
- Gitleaks secret scanning in CI.
- Backend API with Express and PostgreSQL.
- Mobile app (React Native / Expo).
- Browser extension.
- Helm chart for Kubernetes deployment.
