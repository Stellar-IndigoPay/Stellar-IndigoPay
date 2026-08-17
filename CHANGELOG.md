# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
* **extension:** audit `chrome.storage` usage, confirm no plaintext wallet secrets are persisted (signing is delegated entirely to Freighter), and add CI secret-scan to enforce this going forward (closes #656)
- **mobile:** add TLS certificate/public-key pinning for backend API calls — centralized pinned `apiClient`/`pinnedFetch` in `lib/apiClient.ts`, a dependency-free pinning policy + validation module (`lib/pinning.ts`) with a dev-build allowlist, additive-first (grace-pin) rotation, HMAC-SHA256-authenticated remote pin updates, and unit tests for pin validation / mismatch rejection (closes #694)

- **backend:** deduplicate push device tokens per user+device with a sliding expiry window (default 180 days) refreshed on register, soft-invalidate on unregister/expiry, and purge expired tokens from push sends (closes #717)
- **frontend:** announce `DonateForm` validation errors to screen readers via `aria-live="assertive"` region (GrantFox GF-a11y-donate-form)
- **frontend:** add keyboard accessibility for Leaflet map markers on `ProjectMap` — focusable buttons with Enter/Space to open popups (closes #533, grantfox GF-031)
- **frontend:** complete 100% i18n coverage across all locale dictionaries with pluralization and locale-aware formatting (closes #264, #262)
- **frontend:** refactor admin verification queue table with `@tanstack/react-table`, sortable columns, status filter pills, responsive mobile expansion, and server-driven pagination
- **frontend:** implement advanced keyboard navigation, global keyboard shortcuts (`Cmd+K`/`Ctrl+K`), route focus management, and skip links
- **frontend:** implement Playwright end-to-end test suite covering donation, dashboard, and admin analytics journeys (GF-052, closes #110)
- **frontend:** build admin audit log viewer with filtering, pagination, and CSV export (GF-028, closes #83)
- **frontend:** build donor impact certificate with shareable OG social preview via `@vercel/og` (GF-022, closes #79)
- **frontend:** admin login now shows the specific failure reason instead of the canonical per-code message (**BREAKING**: token refresh moved to httpOnly cookie)
- **frontend,backend:** add Idempotency-Key support for donation recording — UUID v4 header, 24h replay window (closes #148)
- **frontend,backend:** real-time transparency dashboard with SLO, business metrics, and donation geo-map (closes #253)
- **backend:** standardize structured startup, shutdown, and shutdown-error logging for background workers with graceful queue draining
- **backend:** Redis-backed response caching middleware with request coalescing (single-flight) to prevent cache stampede (GF-044, closes #149)
- **backend:** implement Soroban RPC retry with exponential backoff and circuit breaker (GF-043, closes #100)
- **backend,frontend:** JWT refresh token rotation and session management for admin auth (GF-032, closes #87)
- **backend,monitoring:** Postgres connection pool observability dashboard with adaptive pool sizing (closes #244)
- **backend:** webhook delivery queue with pg-boss — 6-attempt exponential backoff (30s → 6h), DLQ, GitHub-style HMAC-SHA256 signing, 5-min replay window
- **backend:** webhook + AI summary Prometheus metrics
- **backend:** new database tables: `webhook_deliveries`, `webhook_dlq`, `prompt_versions`, `ai_summary_calls`, `refresh_tokens`, `token_blacklist`, `idempotency_keys`
- **monitoring:** multi-window SLO burn-rate alerting with error budget dashboard (closes #240)
- **monitoring:** Alertmanager routing with PagerDuty + Slack + business hours + inhibition rules
- **monitoring:** Prometheus + Grafana + Alertmanager stack with persistent volumes
- **contracts:** enforce Rust formatting via pre-commit hook (closes #60)
- **contracts:** emit `StealthScan` events with project wallet, donation count, and ledger timestamp (closes #514)
- **contracts:** add multi-source TWAP price oracle with freshness protection (closes #281)
- **contracts:** 48h upgrade timelock (`propose_upgrade` / `execute_upgrade` / `cancel`)
- **contracts:** contract-level pause (`pause_contract` / `unpause_contract`)
- **contracts:** two-step admin transfer (`transfer_admin` / `accept_admin` / `cancel`)
- **contracts:** comprehensive Soroban fuzz testing harness with 7 property-based tests and action-sequence fuzzing (#239)
- **contracts:** escrow fuzz target for milestone percentage edge cases (closes #508)
- **contracts,backend:** add opt-in anonymous donations and signed, cached tax receipt PDFs with locked XLM/USD values
- **contracts/backend:** SEP-0007 deep-link support for mobile donations via `web+stellar:pay` URIs
- **docs:** add CONTRIBUTORS.md to credit community work (GF-015, closes #64)
- **docs:** document key service exports with JSDoc for TypeDoc (closes #548)
- **docs:** `docs/README.md` indexes every document by audience (users, developers, operators, contributors)
- **ci:** monthly restore-drill workflow that pulls latest backup and asserts row counts
- **ci:** SBOM generation with anchore/sbom-action, uploads to GitHub dependency graph
- **ci:** Trivy image scan on CRITICAL/HIGH, cosign keyless signing on release tags

### Fixed

- **contracts/oracle:** align TWAP observation window with staleness threshold invariant — reduce `DEFAULT_STALENESS_THRESHOLD` from 720 to 120 ledger sequences to match `MAX_OBSERVATIONS` capacity; enforce constraint that staleness threshold ≥ MAX_OBSERVATIONS at config time to prevent misconfiguration where operators believe oracle has long-window averaging when actual TWAP coverage is limited to ~20 observations (~100 seconds) (GrantFox GF-oracle-twap-alignment)
- **gitops:** ArgoCD Application manifest for chart-driven reconciliation

### Fixed

- **backend:** durable deduplication for Soroban event processing with atomic cursor commit to prevent double-application on restart (closes #679, GrantFox OSS)
- **gitops:** Argo Rollouts canary strategy with Prometheus success-rate analysis
- **k8s:** default-deny NetworkPolicy for the `indigopay` namespace with explicit allow rules
- **k8s:** HPA (min 2, max 10) + PDB (`minAvailable: 1`) for backend and frontend
- **k8s:** ExternalSecret + SecretStore templates for AWS Secrets Manager
- **k8s:** `k8s/secret.example.yaml` template; real secrets gitignored; `secrets-lint.yml` CI check
- **k8s:** NetworkPolicy lint gate — `scripts/validate-networkpolicies.js` fails CI on un-scoped egress rules and `0.0.0.0/0` CIDRs (closes #701)
- **helm:** `_helpers.tpl` with `backendName`, `frontendName`, `commonLabels`; HPA and PDB wired to values
- **ci:** queue-worker integration smoke test — `queueWorkers.integration.test.js` enqueues and consumes pg-boss jobs (profile + match queues) end-to-end against the compose Postgres (closes #702)

### Changed

- **backend:** `webhook.js` defers delivery to `webhookQueue`; public route surface preserved
- **backend:** `server.js` wires `webhookQueue.start` into boot and registers lifecycle shutdown hook
- **backend:** `indexerService` exposes `stop()` for clean Horizon stream shutdown on SIGTERM
- **backend:** pool `statement_timeout` + `connectionTimeoutMillis` tuning
- **contracts:** extracted shared `require_admin` helper; unified admin panic messages
- **frontend:** `LiveDonationTicker` extracted to `React.memo`-wrapped component, eliminating page-wide re-renders
- **backend/frontend Dockerfiles:** pinned to `node:22-alpine`; `npm ci --omit=dev` for reproducible installs
- **backend,frontend:** rebrand design system with indigo/purple color palette
- **ci:** `docker-compose.test.yml` runs integration/smoke tests against the compose Postgres/Redis services instead of blanket-skipping them (closes #702)

### Fixed

* **frontend:** harden the production CSP — drop `'unsafe-inline'` from `script-src` (rely on nonce + `strict-dynamic`) and report violations via `report-to` alongside the deprecated `report-uri` (closes #688)
* **backend:** reload the keeper account before each recurring submission so transaction sequence numbers are never stale — prevents `tx_bad_seq` when the account sequence advances externally or after a failed submission (closes #705)
* **backend:** make Horizon donation indexing idempotent by operation ID, advance the cursor on replay, and allow multiple payment operations per transaction (closes #635)
* **contracts:** skip missing persistent stealth donation entries during scans (closes #506)
* **contracts:** require admin-gated attestation for `donate_asset` path-payment donations — the recorded `xlm_amount` must be co-signed by an admin-appointed attester, so a caller can no longer claim an arbitrary amount (closes #712)
* **contracts:** deduplicate the escrow `Milestone` struct across feature configurations (closes #511)
* **contracts:** add regression tests covering on-time vs late milestone completion reputation tracking
* **contracts:** add missing `VoteDelegation(Address)` and `DelegatedWeight(Address)` variants to `DataKey` enum
* **contracts:** add missing `disputed: false` field to all `Milestone` initializers in escrow integration tests
* **contracts:** repair `fuzz_tests.rs` compilation — add `extern crate alloc` + `Ledger` import, fix strategy cloning
* **contracts:** fix `test_execute_recurring_badge_progression` token allowance (1503 XLM for keeper incentives)
* **backend:** invalidate impact endpoint caches on project status change (closes #016, grantfox GF-016)
* **backend:** require admin authentication for pending project review endpoint (closes #516)
* **backend:** surface geocoding failures as project creation warnings (closes #519)
* **backend:** bound `tags` in project submission schema — max 10 tags, each ≤ 50 chars (closes #520)
* **backend:** webhook retry scheduler uses `boss.send(..., { startAfter })`; deduped enqueue returns existing `deliveryId`
* **backend:** increase WebSocket event deadline from 500ms to 2000ms to eliminate flaky CI
* **backend:** fix pg-boss v10 incompatibility across all queue workers — add explicit `createQueue()` calls and handle `work()` jobs as an array (closes #702)
* **frontend:** resolve `react-hooks/exhaustive-deps` lint warnings in `RecurringDonationsTab` and `WorldMap`
* **ci:** add `timeout-minutes` to all CI jobs to prevent hanging builds
* **ci:** pin trivy-action, actions/checkout, and other actions to specific versions/SHAs
* **ci:** make ZAP target configurable + continue-on-error; gate mobile EAS on `EXPO_TOKEN` secret
* **ci:** suppress gitleaks false positives and fix helm validation in CI
* **k8s:** allow frontend egress to backend on port 4000 (closes default-deny gap)
* **k8s:** tighten backend egress NetworkPolicy — enumerate specific endpoints (Horizon, Soroban RPC, Anthropic, CoinGecko, Resend, Sentry, FCM/Expo/APNs, Nominatim, web3.storage/w3s.link) and remove the over-broad HTTPS rule; webhook egress moved to an opt-in policy (closes #701)
* **helm:** fix `helm template` rendering with missing helpers
* **scripts:** ensure `scripts/setup-dev.sh` installs `mobile` and `extension` dependencies (fix README mismatch)

### Performance

- **backend:** batch Horizon donation stream events to reduce Socket.IO fan-out complexity from O(clients × donations) to O(clients × batches) — configurable 500ms time window and 50-donation max batch size via `INDEXER_BATCH_WINDOW_MS` and `INDEXER_BATCH_MAX_SIZE` environment variables (closes #157)
- **frontend:** optimize Core Web Vitals with `next/image`, `next/font`, and `next/dynamic` bundle splitting (closes #261)

### Removed

- **docs:** `docs/openapi.yml` — stale duplicate of `docs/api/openapi.yaml`

## [1.0.0] - 2026-07-12

### Added

- Freighter wallet connection
- Browse verified climate projects with impact metrics
- Direct on-chain XLM donations to project wallets via Soroban smart contract
- Donor leaderboard ranked by total XLM given
- Project updates — organisations post progress updates to donors
- Node.js backend API (Express + PostgreSQL)
- Mobile app (React Native / Expo) with biometric auth, secure storage, QR donations
- Browser extension (Manifest V3, Chrome + Firefox)
- Docker Compose development environment with hot reload
- Helm chart for Kubernetes deployment
- CI/CD pipelines across all layers (lint, type-check, test, build, e2e, DAST)
- Gitleaks secret scanning in CI
- `/metrics` scrape endpoint with bearer auth
- Lifecycle service for graceful shutdown
- Per-request HTTP metrics middleware
- `prom-client` metrics service
- `X-Request-Id` response header middleware
- AI summary tokens, cost, latency, and outcomes Prometheus metrics
- Webhook delivery + attempt + duration Prometheus counters
- Health split into liveness (`/api/health`) and readiness (`/api/readyz`)
- SBOM generation, Trivy image scanning, cosign image signing
- ArgoCD and Argo Rollouts GitOps manifests
- HPA and PDB for backend and frontend
- Default-deny NetworkPolicy with explicit allow rules
- ExternalSecret + SecretStore for AWS Secrets Manager
- Prometheus + Grafana + Alertmanager monitoring stack
- ErrorBoundary with Sentry capture across frontend, mobile, and backend
- WalletProvider context with lifecycle state machine
- Mobile: AuthGate, AuthProvider with biometric unlock (60s auto-lock), SecureStore, errorReporter

### Fixed

- Various CI pipeline failures across helm, backend, and extension
- Frontend TypeScript build errors and missing API functions
- Contract CI: removed untracked path-patch, suppressed deprecated `Events::publish`, fixed test bugs
- Gitleaks and Trivy false positives
- Helm `_helpers.tpl` for backendName, frontendName, commonLabels
- K8s: frontend egress to backend on port 4000
- K8s: secret.yaml converted to lint-safe `REPLACE_ME` template
- Contract: escrow-contract CEI ordering and contract attribute placement
- Backend: env.js zod v4 API + DATABASE_URL default + observability vars
- Backend: pool `statement_timeout` + `connectionTimeoutMillis` tuning
- Backend: webhook retry scheduler `boss.send` with `startAfter`
