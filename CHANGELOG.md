## [Unreleased]

### Features

* **contracts:** bounded slash history with ring-buffer eviction for oracle reporter accountability (closes #672)
  - Add `SlashEvent` struct and per-reporter `SlashHistoryMeta` ring buffer to `SimpleOracle`
  - New admin-only `slash_reporter(admin, reporter, reason)` entry point records a timestamped slash event
  - History capped at `MAX_SLASH_HISTORY = 20` — oldest entries are evicted in ring-buffer order to prevent unbounded storage growth
  - New read-only `get_slash_count(reporter)` and `get_slash_event_at(reporter, index)` view functions
  - Each slash emits a `slash_ev` event so off-chain observers retain full history visibility
  - 10 new unit tests covering bound enforcement, eviction, access control, and event correctness
  - All 30 oracle contract tests pass; clippy and rustfmt clean

### Performance

* **frontend:** isolate LiveDonationTicker component to eliminate 3.5s page-wide re-render cycle
  - Extract `LiveDonationTicker` into `frontend/components/LiveDonationTicker.tsx` as a `React.memo`-wrapped component
  - Move state rotation (`tickerIndex`) and `setInterval` loop internally inside `LiveDonationTicker`
  - Remove parent `Home` page component re-renders on ticker ticks
  - Add unit test suite in `frontend/components/__tests__/LiveDonationTicker.test.tsx`

### Features

* **backend:** Redis-backed response caching middleware with request coalescing (GF-044, closes #149)
  - New `cacheResponse(ttlSeconds, keyBuilder)` middleware factory with X-Cache: HIT|MISS|COALESCED headers
  - Request coalescing (single-flight) via inflight promise Map to prevent cache stampede
  - `invalidateCache(pattern)` for declarative cache invalidation on mutating writes
  - Cache key convention: `cache:v1:<resource>:<params_hash>` for future migration
  - Default TTLs: 60s leaderboard, 120s project listings, 300s global stats/impact, 600s map
  - Cache invalidation on POST `/api/donations`, POST/PATCH `/api/projects`, POST `/api/profiles`
  - New map route `GET /api/map` returning geo-located project data (10 min cache)
  - New Prometheus metrics: `indigopay_cache_hits_total`, `indigopay_cache_misses_total`, `indigopay_cache_coalesced_total`
  - Cache-Control: `public, max-age=..., stale-while-revalidate=...` headers on cached responses
  - Graceful degradation when Redis is unavailable (pass-through to database, logged warning)
  - 18 unit tests covering cache hit/miss, coalescing, invalidation, Redis failure, hash determinism
* **contracts:** add a multi-source TWAP price oracle with freshness protection (closes #281)
  - Authorised reporters submit timestamped positive prices to a 20-entry circular buffer
  - `get_price` averages the newest 10 observations and preserves the IndigoPay oracle interface
  - Prices older than 720 ledgers use an admin-configured fallback or fail clearly when none exists
  - Added reporter management, overflow protection, events, and comprehensive oracle tests

* **frontend:** implement advanced keyboard navigation, global keyboard shortcuts, route focus management, and skip links
  - Add `frontend/hooks/useShortcuts.ts` — custom keyboard shortcuts hook with modifier checking and input field exclusion
  - Add `frontend/components/GlobalSearchModal.tsx` — search overlay modal accessible via Cmd+K / Ctrl+K with full keyboard navigation (arrows, Enter, Escape) and focus trap
  - Update `frontend/pages/_app.tsx` to handle page focus management, global shortcuts, and App Shell layout (SkipToContent + Navbar wrapper)
  - Update `frontend/components/DonateForm.tsx` to support Space/Enter keys on donation amount preset buttons
  - Update `frontend/components/LanguageSwitcher.tsx` to prevent propagation of the Escape key
  - Add Jest unit tests for `useShortcuts` hook in `frontend/hooks/__tests__/useShortcuts.test.ts`

* **monitoring:** multi-window SLO burn-rate alerting with error budget dashboard (closes #240)
  - Defined SLOs: donation recording (99.5%) and project listing (99.9%) over 30-day rolling windows
  - Recording rules in `monitoring/recording-rules.yml` computing error ratios and budget remaining
  - Multi-window burn-rate alerts: 2% in 1h (page), 5% in 6h (page), 10% in 3d (warn) for both SLOs
  - Grafana dashboard: error budget gauges (green/yellow/red thresholds), burn-rate timeseries, top-5xx-routes table
  - SLO definitions and burn-rate alert response runbook in `docs/performance.md`
  - Prometheus `prometheus.yml` updated to load recording-rules.yml and alert-rules-routing.yml

* **backend,monitoring:** Postgres connection pool observability dashboard with adaptive pool sizing (closes #244)
  - New `db_pool_max` Prometheus gauge tracks the current pool capacity
  - Adaptive pool sizing: if saturated (all connections busy with waiters) for 60 s, increase max by 25 % up to `PG_MAX_HARD_CAP` (default 50)
  - `parameterizeQuery()` helper replaces string and numeric literals with `$N` placeholders for PII-safe slow-query logging
  - `extractQueryType()` classifies SQL queries as SELECT/INSERT/UPDATE/DELETE/WITH/OTHER
  - Queries taking >1 s trigger EXPLAIN (ANALYZE, BUFFERS) fire-and-forget (gated by `DB_EXPLAIN_SLOW_QUERIES=true`)
  - Grafana dashboard: connection pool health panels (heatmap, gauges for active/idle/waiting, pool max vs active timeseries, slow query count stat)
  - New alert rules: `DBPoolSaturated` (warn, waiting > 0 for 5 m), `DBPoolExhausted` (page, all connections busy + waiters for 10 m with PagerDuty routing)
  - 26 new unit tests (16 pool, 10 metrics)

* **frontend,backend:** real-time transparency dashboard with SLO, business metrics, and donation geo-map (closes #253)
  - New public dashboard page at `/transparency` with platform health banner, impact stat cards, live donation map, and recent donations feed
  - Health banner polls `/api/readyz` every 30s displaying operational/degraded/outage status with expandable detail rows
  - Impact overview with 4 animated stat cards (total donated, CO₂ offset, active projects, unique donors) using `AnimatedNumber`
  - Enhanced `WorldMap` component supports real-time donation markers with pulse animations and fade-out effects
  - SLO status panel with error-budget gauges for donation and project-listing SLOs, visible only when a wallet is connected
  - Custom hooks (`useGlobalStats`, `useSLOData`) with configurable polling intervals
  - New backend endpoint `GET /api/admin/metrics/slo` proxies Prometheus SLO recording rules with per-query error isolation
  - 10 frontend unit tests (4 HealthBanner, 4 StatCard, 4 SLOStatusPanel) + 4 backend SLO endpoint tests

* **frontend:** implement Playwright end-to-end test suite covering critical user journeys (GF-052, closes #110)
  - Set up Playwright configuration in `playwright.config.ts` with Next.js dev server and Chrome browser projects
  - Implement mock fixtures for Freighter wallet injection (`freighter.ts`), Horizon API/Soroban RPC responses (`horizon.ts`), and backend REST endpoints (`api.ts`)
  - Implement E2E specs for (1) browse projects → donate XLM (`donation.spec.ts`), (2) wallet connect → view dashboard (`dashboard.spec.ts`), and (3) admin login → platform analytics (`admin-analytics.spec.ts`)
  - Set up GitHub Actions CI integration for automated E2E test runs

* **backend,frontend:** JWT refresh token rotation and session management for admin auth (GF-032, closes #87)
  - Access tokens cut to 15 minutes and carry a `jti`; refresh tokens are opaque, DB-backed, and live 7 days
  - New `refresh_tokens` and `token_blacklist` tables via migration 019
  - `POST /api/admin/refresh` rotates the refresh token on every call; replaying a revoked token revokes its entire family
  - `POST /api/admin/logout` revokes the session family and blacklists the access token's `jti` until natural expiry
  - `GET /api/admin/sessions` lists active sessions; `POST /api/admin/sessions/:id/revoke` kills one
  - Refresh token moved to an httpOnly, Secure, SameSite=Strict cookie scoped to `/api`; `/admin/refresh` and `/admin/logout` are exempt from csurf since the cookie is their only credential
  - Hourly pg-boss cleanup cron (`blacklistCleanup`) purges expired rows from both tables (configurable via `BLACKLIST_CLEANUP_CRON`)
  - Frontend: `adminAuth.ts` holds the access token in memory only, refreshes single-flight, and rehydrates the session on mount
  - Rotation claims the presented token with a compare-and-swap, so two concurrent refreshes cannot both mint a successor
  - Logout only blacklists tokens the server signed; the endpoint is unauthenticated, so decoding without verifying would let anyone write a chosen `jti` and expiry
  - 36 backend tests (`admin.test.js`), 20 frontend tests (`adminAuth.test.ts`)

* **frontend:** admin login now shows the specific failure (`reason`) instead of the canonical per-code message, so a wrong password reads "Invalid credentials" rather than "Authentication required"

  **BREAKING**: `POST /api/admin/login` no longer returns `refreshToken` in the body and `expiresIn` is now 900; `POST /api/admin/refresh` reads the `refresh_token` cookie instead of a JSON body. Existing admin tokens are invalidated — admins must log in again.

* **backend,frontend:** add Idempotency-Key support for donation recording (closes #148)
  - Accept `Idempotency-Key` header (UUID v4) on `POST /api/donations`; store response and replay within 24 hours
  - New `idempotency_keys` table via migration 016 with index on `created_at`
  - Hourly pg-boss cleanup cron (`idempotencyCleanup`) purges expired keys (configurable via `IDEMPOTENCY_CLEANUP_CRON`)
  - Frontend: `DonateForm` and `bridge` generate `crypto.randomUUID()` per donation attempt
  - Documented in OpenAPI spec with 200 replay response
  - 11 new tests: 5 unit (donations), 8 unit (cleanup), 3 integration (testcontainers)

* **docs:** add CONTRIBUTORS.md to credit community work (GF-015, closes #64)

* **frontend:** build admin audit log viewer with filtering and CSV export (GF-028, closes #83)
  - Add `/admin/audit` page with filterable, paginated audit log table
  - Add `AuditLogTable.tsx` — reusable component with filters (actor, action, target, date range, full-text search), pagination (50/page), and CSV export
  - Add "Audit Log" link to admin navigation sidebar
  - Fetch distinct action values from stats API for the action filter dropdown
  - CSV export downloads via `GET /api/admin/audit-log/export/csv` with current filters
  - 15 frontend test cases covering all filter states, pagination, export, loading/error/empty states

* **frontend:** build donor impact certificate with shareable OG social preview (GF-022, closes #79)
  - Add server-rendered OG image endpoint `/api/og/donor/[publicKey]` using `@vercel/og` (1200×630px, Edge Runtime)
  - Generate styled impact card with donor name, XLM donated, badge tier, CO₂ offset, and CTA
  - Add `ShareButton.tsx` — reusable component with Twitter/X, LinkedIn, and copy-link buttons with hover states
  - Update donor profile page with `og:image`, `twitter:card=summary_large_image`, and dynamic share text
  - Cache OG images for 1 hour via `Cache-Control: public, max-age=3600`

* **backend:** implement Soroban RPC retry with exponential backoff and circuit breaker (GF-043, closes #100)
  - Add `backend/src/services/circuitBreaker.js` — reusable `CircuitBreaker` class (CLOSED / HALF_OPEN / OPEN state machine, configurable `failureThreshold` and `resetTimeout`)
  - Export `indigopay_soroban_circuit_breaker_state` Prometheus Gauge (0=closed, 1=half_open, 2=open)
  - Update `backend/src/services/stellar.js` with `withRetry()` (exponential backoff: 100ms → 200ms → 400ms, max 3 retries env-configurable via `SOROBAN_RPC_MAX_RETRIES`) and `rpcBreaker` circuit breaker wrapping all Soroban RPC calls
  - Export `indigopay_soroban_rpc_retries_total` Prometheus Counter
  - Update `backend/src/routes/readiness.js` to include `soroban_rpc` health check in `/api/readyz` response (reports `ok` or `degraded`)
  - Add 33-test suite `backend/src/services/circuitBreaker.test.js` covering state machine, `isRetryable` classification, retry logic, circuit breaker open/half-open/closed transitions, and Prometheus metrics

---

# 1.0.0 (2026-07-12)


### Bug Fixes

* **backend:** add missing zod, profileQueue, and donationEvents imports in donations route ([1f9e8b0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1f9e8b0568e5ba737674adab596e1f38156fbeb3))
* **backend:** env.js zod v4 API + DATABASE_URL default + new observability vars ([6caf834](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6caf834466c2140e243d4abe5b266d2c30768664))
* **backend:** indexer service stop() for clean shutdown ([183da6b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/183da6b37e79dad3f761d7269706bed7b93335a1))
* **backend:** pool statement_timeout + connectionTimeoutMillis tuning ([225da4a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/225da4a4256c2b1a675f06543b06d2c42cf3fa92))
* **backend:** webhook retry scheduler uses boss.send startAfter; deduped enqueue returns existing deliveryId ([211ab07](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/211ab07aba32a262b3ca7031bd15653093dd2aea))
* **ci:** make ZAP target configurable + continue-on-error; gate mobile EAS on EXPO_TOKEN secret ([2e54aab](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2e54aab067896690fce8607f1a9485c8d3db4e46))
* **ci:** pin backend Dockerfile to node:20.18.1-alpine with SHA256 digest; switch to npm ci --omit=dev ([2e960fb](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2e960fb58792a98bd347d0ef0e76cd1141e0161d))
* **ci:** pin frontend Dockerfile to node:20.18.1-alpine LTS; switch to npm ci --omit=dev ([0a165cf](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0a165cf89bbce9423b1c88fd6f699ec444904033))
* **ci:** pin secret-scanning workflow to actions/checkout@v4 (v6 does not exist) ([b2b38ce](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b2b38ced98e35185f9d8cb0f6955c1c982f2e6b4))
* **ci:** pin trivy-action to commit SHA b6643c0e5cc8a9c9b5b2cb06a73c4a3d9eb7c5d2 ([08e3545](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/08e354528d18cf7b91ddca8d91b96d6705bd1b73))
* **ci:** remove fabricated SHA256 digests from backend Dockerfile (3 stages) ([c93d4f6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/c93d4f6d3feedee16f3798751f38526fb70e44f6))
* **ci:** resolve 5 CI pipeline failures (lints, a11y, contracts, gitleaks, helm) ([d4eb13a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d4eb13a1d09a115630f147ebb5919fc09087b1cc))
* **ci:** resolve backend test failures and frontend ESLint config ([f2e7c28](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f2e7c282fa98dce99a6dadcd52e38c4f72041e6a))
* **ci:** revert fabricated trivy SHA back to tag with note to pin in production ([63021e2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/63021e24beade8229802d69a5bf1fd030fb29a4b))
* **ci:** suppress gitleaks false positives and fix helm validation in CI ([ef13c6f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ef13c6f65a089af4003eb66dd4b26506e38a0131))
* **escrow-contract:** apply CEI ordering and correct contract attribute placement ([6929405](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6929405823116dd74b855b8ff6b59bbdcfae3b2b))
* explicitly set toolchain 1.91.0 in contracts.yml so rustfmt/clippy are installed for the right version ([86b5afc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/86b5afce43f9ffba73043669d3db827b25e3ab4b))
* **frontend:** downgrade eslint to ^8.57.0 to match eslint-config-next@14.2.3 peer-dep range ([16b35b5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/16b35b52845774b03493b93fc7b223d57e192f84))
* **frontend:** fully regenerate package-lock.json (npm ci was missing to-buffer@1.2.2) ([6c1e207](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6c1e207ecdb1945aa98f57744efb2a9baf208733))
* **frontend:** repair broken JSX in ProjectCard (nested button, mismatched tags, duplicate Donate element) ([f0c0018](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f0c001872eca8effbcfb160a143774702aabbd0e))
* **frontend:** resolve all TypeScript build errors and add missing API functions ([4d8062b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4d8062b4f7d0811a473d63f53e7f64aa0bf6b75d))
* **helm:** add _helpers.tpl with backendName, frontendName, commonLabels ([6b3c457](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6b3c4574da4bbaaf73379d0553bb547e32d17206))
* **k8s:** allow frontend egress to backend on port 4000 (closes default-deny gap) ([f0d980a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f0d980a67ff3cc1a29fd9ea11a62d62ac60ccea6))
* **k8s:** convert k8s/secret.yaml to REPLACE_ME template (lint-safe) ([9a2403e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9a2403ea124d2c3643b69afaf1c1a0740a3a671a))
* **k8s:** use __LIKE_THIS__ placeholders so secrets-lint does not trip on the template ([2acbb02](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2acbb028ace6087c796ef603535772fbb85c7c24))
* pin trivy-action to specific version 0.28.0 instead of master ([ea871dc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ea871dc23454308172d46e54886b16ba086031dc))
* rebuild Soroban Contracts CI and fix all remaining CI failures ([09aaa96](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/09aaa9653320da5ec35597a7aa88992725d397e4))
* resolve all five CI failures ([35897d0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/35897d05e271281caee881e358f01ab33034decf))
* resolve CI failures across helm, backend, and extension ([1341905](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/13419050451a7004140a8b73115da22498fe4836))
* resolve remaining CI failures (gitleaks, trivy, contracts) ([ec7f27a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ec7f27aaf91a1c8e5d789dab60e12a46eed210a4))
* resolve Soroban Contracts CI failures - remove untracked path-patch, suppress deprecated Events::publish, fix test bugs ([a4cc10a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a4cc10ab7214491cde230daf6df05ae6e56ff025))


### Features

* **backend:** add /metrics scrape endpoint with bearer auth ([b433759](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b433759bb041874426ad0c5208f42a716870c1de))
* **backend:** add lifecycle service for graceful shutdown ([1ce9d93](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1ce9d9373c00c76709aaeedab8a8339a2b47c646))
* **backend:** add per-request HTTP metrics middleware ([4975707](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4975707e6ff61fdd0ec2dc7ef810010da7215778))
* **backend:** add prom-client metrics service ([c813fe6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/c813fe6d7e78ce5f006ee7eda2db442536068cc5))
* **backend:** add X-Request-Id response header middleware ([f810414](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f810414c625c8c9ec305d01b3aaf7c970a547063))
* **backend:** ai_summary tokens, cost, latency and outcomes Prometheus metrics ([dba7a67](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/dba7a672ef95ba16e1cfd333cab3014531cdab56))
* **backend:** rewrite server.js bootstrap with proper middleware order ([088f6af](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/088f6afcd80062c68076634b5676e8c526df4941))
* **backend:** split health into liveness and readiness ([9f248b4](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9f248b4f195a50bb83bbc6769d23f7acda896501))
* **backend:** webhook delivery + attempt + duration Prometheus counters ([ba2f32b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ba2f32b50a7b925e24144ea71c97f0cb98932a4b))
* **backend:** webhook delivery queue with pg-boss, DLQ, GitHub-style signing ([2a2b586](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2a2b58635f002eb34bb653b43767d6c4a50b5f95))
* **backend:** webhook signing helper with GitHub-style t=...,v1=... + replay window ([0b77240](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0b772402ccbc057fbb81fe5fa451613aec5d0130))
* **backend:** wire webhookQueue.start into boot + lifecycle shutdown ([e310cdb](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/e310cdb5f2f9f54d81cef97098d95330af36a059))
* **ci:** monthly restore-drill workflow that pulls latest backup and asserts row counts ([fe1af2c](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/fe1af2cbdd37d928bbf4da42091e11b928923389))
* **ci:** SBOM generation with anchore/sbom-action, uploads to GitHub dependency graph ([d70d0a6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d70d0a6b869a908e269881e1196e9b524ab56c6f))
* **ci:** Trivy image scan failing on CRITICAL/HIGH with fix available ([a5c47ae](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a5c47aeb0fda34a6b10ea73bf20358ac9cc99909))
* **contracts:** 48h upgrade timelock (propose_upgrade / execute_upgrade / cancel) ([f9a7a33](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f9a7a33b59517d17fa58c604fa4454af0ecf2e01))
* **contracts:** contract-level pause (pause_contract / unpause_contract) ([dcd8c87](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/dcd8c87c72097bd9bb8c7af3624f0961c5779b13))
* **contracts:** two-step admin transfer (transfer_admin / accept_admin / cancel) ([7049578](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/70495788eb9ea7069a590a446171a5fceda82544))
* **db:** add prompt_versions and ai_summary_calls tables ([0e4b982](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0e4b982b6aefff488e5ba0c9f0919e09e32af1cb))
* **db:** add webhook_deliveries and webhook_dlq tables for retry bookkeeping ([53619d6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/53619d67de508e40dfcbc2e1d97f6b70db9b474d))
* **frontend:** add ErrorBoundary with Sentry capture and prod-safe fallback ([cc8332d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/cc8332d4a3390292bd4f87bb8f5588cf6dcdf917))
* **frontend:** add WalletProvider context with lifecycle state machine ([7a31511](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/7a31511da3c4bb1cad184bafeb32fbe226116a73))
* **frontend:** wire WalletProvider + ErrorBoundary into _app.tsx ([177d7e2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/177d7e217c5448311b51b26c8e5cfbc69965ad5d))
* **frontend:** wire withSentryConfig into next.config.mjs ([a39230a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a39230a72dfe72c0303def8c2cf91e92246bd07a))
* **gitops:** Argo Rollouts canary strategy with Prometheus success-rate analysis ([58fca67](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/58fca679818ddca1a0c0cde05ae42f31c0ca608b))
* **gitops:** ArgoCD Application manifest for chart-driven reconciliation ([8ba7026](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/8ba7026da4e2bb67a2a4d752f58806d65154a848))
* **helm:** HPA template wired to values.autoscaling ([e03eb40](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/e03eb40110f458ed6c57cf48d82ab521d966704b))
* **helm:** PodDisruptionBudget template wired to values.pdb ([0007965](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0007965ad16ce9cd352dff690503cc8b23fe9e1f))
* **indigo-contract:** add project lifecycle pause/resume and bulk-deactivate admin functions ([fb4968f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/fb4968f0c590ae37a966036cfe6520a3dc61970e))
* **k8s+helm:** ServiceMonitor + metrics port + probes + secrets ([7844f6b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/7844f6b6da832e6756448c1b504d678c6742088d))
* **k8s:** allow backend egress to postgres on 5432 plus kube-dns ([9c66e74](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9c66e74a6c0499d1797d16ee8437ff458b3dbe2d))
* **k8s:** allow backend egress to redis on 6379 ([d083f61](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d083f6139fead839e29cd51534318226b7c0c7d6))
* **k8s:** allow backend egress to Stellar Horizon, Soroban RPC, Anthropic, Sentry ([1c95044](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1c95044acbf0cdf2fa8a8f329feacfe8e0d28a2d))
* **k8s:** allow ingress-nginx to reach backend on port 4000 ([a441e1f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a441e1f6ac732539b4db2604fa60a870fe419221))
* **k8s:** allow prometheus to scrape backend /metrics on port 4000 ([2b2f094](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2b2f0945210ca40bfc303a0ab9a4dd55ad2693ac))
* **k8s:** default-deny NetworkPolicy for the indigopay namespace ([4a6065d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4a6065dca11278f3a976ddbfa00749171a53c546))
* **k8s:** ExternalSecret + SecretStore template for AWS Secrets Manager ([b070c22](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b070c229a69166d0e58d35fc9c4bf2f9d6c8025d))
* **k8s:** HPA for backend, min 2 max 10, CPU 70% + memory 80% ([9572668](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9572668529c84410d3104dc8661e1ab75611c3b4))
* **k8s:** HPA for frontend, min 2 max 10, CPU 70% + memory 80% ([05b4828](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/05b482814dda07266592a8e10139f72b8b9fc3ef))
* **k8s:** PodDisruptionBudget for backend with minAvailable 1 ([f975210](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f975210c9a4c406ae40ae6607b7ded9be5328c94))
* **k8s:** PodDisruptionBudget for frontend with minAvailable 1 ([bfb7fac](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/bfb7fac963c9313bf87788e694c442ec4ce35f0d))
* **k8s:** ServiceAccount stub for external-secrets-operator IRSA binding ([2cc0156](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2cc0156c2b55cc0f033bd1c0bdabeab3d9dd2ff6))
* **mobile:** add AuthGate with state-aware fallback UI ([1933d34](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1933d34204691137b5143acc08e2e6835cd01f0e))
* **mobile:** add AuthProvider context with biometric unlock and 60s auto-lock ([5c37c00](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/5c37c005e5a70a3dfc32d1f774bbedeb9adfda71))
* **mobile:** add fire-and-forget errorReporter sink with Sentry forwarding ([007f01b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/007f01b6b8e40aaa586afeb5a77ed70505aaaa3a))
* **mobile:** add global ErrorBoundary with prod-safe fallback ([24e1cbc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/24e1cbc778bd98c3700fe264262c8d92bb47db5f))
* **mobile:** add SecureStore wrapper with biometric-gated options ([73c16fa](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/73c16fa4d35b5c381013acc56d107840cf676bb6))
* **mobile:** wire ErrorBoundary + AuthProvider into _layout.tsx ([8cedc0a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/8cedc0a2798d10440fb4f09af6ab14d01e01b270))
* **monitoring:** alertmanager routing with PagerDuty + Slack + business hours + inhibition ([71cc086](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/71cc0864c8096a6a4ef4afd33d3aa73c0b78333b))
* **monitoring:** Prometheus + Grafana + alert rules + dashboard ([34bf716](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/34bf716edfb3f62faf9cfff21a7307733c219c37))
* **monitoring:** routing-aware alert rules (BackendDown, BackupMissed, RestoreDrillFailed) ([878fd8e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/878fd8ef160a7aef493e7c67cbb6670bcf034cfa))
* rebrand frontend design system with indigo/purple color palette ([724ef57](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/724ef57b271e8540f5c6a0686d3b1321c6d81ed1)), closes [#227239](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/227239) [#2d6a2d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/2d6a2d) [#f0f7f0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/f0f7f0) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE)
* update email templates with indigo color scheme ([4b5b7f2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4b5b7f21e72d55b4d0e8640656bf57b6d75bd491)), closes [#2d6a2d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/2d6a2d) [#f0f7f0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/f0f7f0) [#1a3a1a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1a3a1a) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE) [#0F172A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0F172A)
* update frontend donation components with indigo colors ([4a2ebc0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4a2ebc078dc8c35433743a3950c727bee7689273)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8)
* update frontend leaderboard, wallet and utility components with indigo colors ([cace51e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/cace51e90497ff948a254b9c2c8df86148160b2d))
* update frontend Navbar with indigo logo styling ([2350b4e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2350b4ee2d704eda9e84b95c33b2810b84dd940f)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8)
* update frontend pages with indigo design system ([09ab67c](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/09ab67cdfa86374a0f847ed9ec83e8e3e276b13d)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#0F172A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0F172A)
* update frontend project components with indigo palette ([6516483](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6516483c5e5b09bfeeb40e51588b83794547c591))
* update frontend UI components with indigo design ([b04aca1](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b04aca1bfc9837347535b5f5dc9d1a6091684274))
* update mobile app theme with indigo palette ([d6da922](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d6da92249ea6ea07a1ee07e4e896ca9577da5a8d)), closes [#227239](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/227239) [#5a7a5a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/5a7a5a) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#0A0A1A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0A0A1A) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE)

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **indigopay-contract:** Reconciled the campaign escrow custody model by funding the escrow job directly from `ProjectContractBalance(project, token)` instead of `project.total_raised`. This prevents escrow creation failures when donations bypass the contract (e.g. direct-to-wallet) and correctly rejects funding with `InsufficientContractBalanceForEscrow` if the contract holds insufficient funds.
- **backend:** Serialize migration runs across replicas with a Postgres advisory lock so concurrent boot (k8s HPA min 2) can never apply the same migrations twice (closes #640). Also fixes the migration chain so a fresh database can be bootstrapped end-to-end: `002` drops `CREATE INDEX CONCURRENTLY` (invalid inside the runner's transaction), a new `010_admin_audit_log` migration creates the audit table `011` depends on, `011`'s hash-chain backfill is repaired (uuid/json casts, missing CTE column, `pgcrypto` extension), `021` uses drop-then-add for its CHECK constraint, and `027` guards its example `credits` migration against a missing table. Adds a testcontainers concurrency test proving two concurrent `runMigrations()` calls apply each migration exactly once.
- **backend:** Enforce match pool caps atomically at match-time using row-level locks, preventing pools from overspending under concurrent load.

### Added

* **mobile:** add jailbreak/root detection via `expo-device` with a configurable `EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` (off/warn/block, default block) wired into biometric auth, secure storage, and session unlock so compromised devices trigger the policy (closes #693)
- **backend/security:** Load guardian and recurring keeper signing seeds from managed secret files, add signer provider tests, and document signer rotation workflow.

* **extension:** audit `chrome.storage` usage, confirm no plaintext wallet secrets are persisted (signing is delegated entirely to Freighter), and add CI secret-scan to enforce this going forward (closes #656)
* **mobile:** audit auth client and confirm it uses a distinct nonce-based wallet session that is unaffected by the admin JWT `httpOnly` cookie rotation changes (closes #655)

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

- **contracts:** enforce a 15-weighted-vote quorum in `resolve_proposal` — proposals below the floor resolve as rejected with a dedicated `prop_noq` event (closes #714)

### Fixed

- **ci,extension:** stop tracking the generated `greenpay-extension.zip` in git, generate it from source in CI, and verify the packaged artifact is reproducible across two builds (closes #696)
- **contracts:** prevent challenge and refund flows from reversing the same donation twice; invalid finalization attempts now return structured errors instead of underflowing accounting.
- **frontend:** pin locale (`en-US`) and timezone (`UTC`) for date/number formatting helpers (`formatDate`, `formatDateTime`, `formatTime`, `formatMonthYear`, `formatNumber`) and replace raw `Intl.*`/`toLocaleString` calls in SSR-rendered components, making server/client output deterministic and eliminating hydration mismatches (closes #652)
- **contracts/oracle:** align TWAP observation window with staleness threshold invariant — reduce `DEFAULT_STALENESS_THRESHOLD` from 720 to 120 ledger sequences to match `MAX_OBSERVATIONS` capacity; enforce constraint that staleness threshold ≥ MAX_OBSERVATIONS at config time to prevent misconfiguration where operators believe oracle has long-window averaging when actual TWAP coverage is limited to ~20 observations (~100 seconds) (GrantFox GF-oracle-twap-alignment)
- **contracts:** allow `mint_impact_nft` to mint any previously-earned badge tier at or below the donor's current badge (rank-order comparison), so a donor who progressed to a higher tier can still mint lower-tier Impact NFTs once each (closes #674)
- **gitops:** ArgoCD Application manifest for chart-driven reconciliation

### Fixed

- **backend:** fix `auditChain.js` canonicalization to be injective and prevent hash collisions from pipe characters
- **backend:** durable deduplication for Soroban event processing with atomic cursor commit to prevent double-application on restart (closes #679, GrantFox OSS)
- **backend:** compute donation/CO₂ projection arithmetic in BigInt (and keep stroop amounts as exact decimal strings) so i128 donations beyond 2^53 stay integer-exact in the leaderboard/impact/CO₂ projections instead of being rounded by JS `Number` (closes #681)
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
- **contracts:** `batch_donate` and `batch_register_projects` now enforce a maximum batch size of 50; oversized batches are rejected with a structured contract error

### Fixed

* **contracts:** `donate_vested` pays the integer-division remainder with the final installment and `cancel_vesting` refunds it exactly, so no dust is stranded in contract custody and the project is fully paid (closes #665)
* **contracts:** `cancel_vesting` marks the schedule as fully consumed so repeated cancels and post-cancellation claims are rejected, preventing double payouts from custody
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

- **contracts:** move `DataKey::{Nullifier, ZkDonationRecord}` from instance to persistent storage so the ZK anonymous-donation path (`donate_anonymous_zk`/`donate_anonymous`) no longer grows the always-loaded contract instance entry with every donation; each entry gets its own footprint and TTL, extended to a documented ~1-year retention window on write (closes #706)
- **backend:** batch Horizon donation stream events to reduce Socket.IO fan-out complexity from O(clients × donations) to O(clients × batches) — configurable 500ms time window and 50-donation max batch size via `INDEXER_BATCH_WINDOW_MS` and `INDEXER_BATCH_MAX_SIZE` environment variables (closes #157)
- **frontend:** optimize Core Web Vitals with `next/image`, `next/font`, and `next/dynamic` bundle splitting (closes #261)
- **backend:** bound admin analytics aggregates with a per-query statement timeout, capped date windows, and row limits; add a `created_at` index on `donations` and EXPLAIN regression tests asserting the time-window queries stay index-backed (closes #718)

### Removed

- **docs:** `docs/openapi.yml` — stale duplicate of `docs/api/openapi.yaml`

### Security

* **backend/security:** harden AI project summaries against prompt injection and unsafe output — frame project content in typed delimiters with system-prompt guardrails, and strip/truncate markdown and HTML from generated summaries before storage and serving (closes #684)
* **contracts/escrow-contract:** harden milestone payout arithmetic against integer overflow (closes #616)
  - `release_milestone`, `claim_milestone`, `resolve_milestone_dispute`, and `compute_remaining_funds` now compute `amount * percentage / 100` with `checked_mul` / `checked_div` via a shared `compute_proportional_payout` helper instead of raw `*` / `/`
  - `job.amount` is fully client-controlled at `create_job` (any positive `i128`); because the contracts workspace release profile previously shipped with `overflow-checks = false`, a near-`i128::MAX` amount silently wrapped to an incorrect (small) payout while the full amount stayed locked
  - Overflow now surfaces the reserved structured `EscrowError` codes (`ReleaseAmountCalculationFailed`, `ClaimAmountCalculationFailed`, `RefundAmountCalculationFailed`) via `panic_with_error!` instead of silently wrapping; full-payout `100`-percent milestones are short-circuited to `amount` so the tautological `amount * 100` intermediate cannot falsely overflow
  - Enabled `overflow-checks = true` in the contracts workspace release profile as defense-in-depth
  - Added regression tests asserting the exact contract error code for the release, claim, milestone-dispute, remaining-funds, and refund paths, plus guards confirming normal and full-payout amounts are unaffected

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
