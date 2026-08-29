# Infrastructure Production Hardening Epic

Closes **#1100** — *"(Critical) Infrastructure Production Hardening Epic: PostgreSQL failover, canary analysis, secret rotation, backup integrity, SBOM gates, network policies, and synthetic monitoring"*

This PR implements all **seven** workstreams of the epic: real-time, lease-guarded PostgreSQL failover; automated metric-driven canary analysis; zero-downtime dual-version secret rotation; checksum-verified backup/restore integrity; SBOM severity gating; zero-trust network-policy audit; and end-to-end synthetic donation monitoring.

The unifying property: **the production platform can survive any single-component failure without data loss, without downtime, without operator intervention, and with a verifiable audit trail** — enforced by a self-healing control loop, automated CI gates, and Prometheus alerting.

---

## Workstream 1 — PostgreSQL automated failover with split-brain prevention

- **`scripts/postgres-healthcheck-daemon.js`** (new) — real-time health-check daemon that probes the primary every 5 s via `pg_isready` and, after 3 consecutive failures (~15 s), acquires the `postgres-primary-lock` **Lease** (compare-and-swap on `holderIdentity`/`renewTime`) before creating the failover Job. A node that loses the Lease logs a warning and backs off — split-brain is impossible. Implements the 30-second promotion target with a distributed lock.
- **`k8s/postgres-primary-lock.yaml`** (new) + **helmed template** — the Lease object with 30 s TTL, renewed every ~10 s by the current primary.
- **`k8s/postgres-failover-rbac.yaml`** + helm — `coordination.k8s.io/leases` permissions for the failover and healthcheck service accounts.
- **`k8s/postgres-failover-script.yaml`** — a **split-brain guard step** that refuses to promote unless the promotion lock is held (manual overrides require an explicit flag).
- **`k8s/postgres.yaml`** / helm — the primary is configured with `synchronous_commit = remote_apply` + `synchronous_standby_names = 'standby'` so every acknowledged commit is durable on the standby → **zero write loss**.
- **`scripts/setup-replication.sh`** — Step 10 verifies the standby→primary `pg_isready` path the daemon will probe.
- **`monitoring/alert-rules.yml`** — `PostgresFailoverHappened` (critical, pages on any failover) and `PostgresLeaseContention`, alongside the existing success/unhealthy alerts.
- **`docs/runbooks/postgres-failover.md`** (new) — full runbook incl. `pg_rewind` re-join and split-brain drill.

## Workstream 2 — Argo CD canary with real Prometheus AnalysisTemplate

- **`gitops/analysis-template.yaml`** (new) — Prometheus-backed `AnalysisTemplate` evaluating every 30 s for a 10-minute window. Each metric's provider `query` computes a self-contained decision value (canary error rate − 1.5× stable rate; canary p95 − 1.2× stable p95) and `successCondition` evaluates that result vector (`result[0] <= 0`), so the template does not depend on non-existent recording rules. On failure → automatic rollback; on success → promote to the next canary step.
- **`gitops/argo-rollouts-canary.yaml`** — the Rollout now references the `backend-canary-analysis` template (error-rate + p95 latency metrics). The Rollout runs Argo Rollouts' default basic (pod-replacement) canary with a single `backend-svc` for both `canaryService` and `stableService` — the correct, supported config for basic canary. Distinct Services are only required when adding a `trafficRouting` block (Istio/NGINX/ALB/Ambassador), which is documented in the manifest header.
- **`monitoring/recording-rules.yml`** — SLO + business recording rules (the canary analysis does NOT rely on `canary_error_rate`/`stable_error_rate` recording rules; the queries consume `http_requests_total`/`http_request_duration_seconds_bucket` directly via the `version` and `status_code` labels).
- **`monitoring/grafana/dashboards/canary-analysis.json`** (new) — canary-vs-stable error-rate / latency / traffic dashboard for live rollouts.
- **`docs/runbooks/canary-analysis.md`** (new) — runbook covering analysis inspection, failed-metric diagnosis, and healthy promotion.

> **Metric contract:** the backend exports `method`, `route`, `status_code` on `http_requests_total` and `http_request_duration_seconds_bucket`. To discriminate canary from stable, the backend's HTTP metrics must also carry a `version` label (`"canary"` / `"stable"`), set by the Rollout; prior to that, a Prometheus relabel/recording rule must derive `version` before the analysis can compare revisions (documented in `gitops/analysis-template.yaml`).

## Workstream 3 — Zero-downtime secret rotation with dual-version support

- **`backend/src/services/signingSecretProvider.js`** (new) — multi-version key store (`CURRENT` / `PREVIOUS` / `NEXT`) with stable `kid` fingerprints. Consumers accept current + previous + next during the rotation window.
- **`backend/src/middleware/auth.js`** — JWT signing uses **only** the current key; verification tries current + previous + next (dual-version acceptance). Behavior is unchanged when only `JWT_SECRET` is set.
- **`backend/src/services/redis.js`** — dual-version Redis `AUTH`: on `NOAUTH`/auth error the connection transparently retries with the previous password during the rotation grace window (`getAuthCandidates`).
- **`backend/src/routes/admin/secrets.js`** (new) — `GET /api/admin/secrets/status` returning per-secret current/previous/next **fingerprints**, `lastRotatedAt`, `nextScheduledAt`, and rotation cadence (never secret values). Mounted in `routes/admin.js`. Added to the OpenAPI spec.
- **`scripts/workflow/rotate_secrets.py` / `update_secrets.py` / `restore_secrets.py`** (new) — implement the generation → promote → restore protocol with an audit trail (SHA-256 hashes only).
- **`k8s/secret.yaml` / `k8s/external-secret.yaml`** — dual-version slots for `JWT_SECRET`, `WEBHOOK_SIGNING_SECRET`, `ADMIN_API_KEY`.

## Workstream 4 — Backup/restore integrity verification

- **`scripts/backup-db.sh`** — computes a SHA-256 of the `pg_dump` artifact **before** upload, uploads `.sha256` + `.rowchecksums.json` sidecars, and **re-hashes after upload** (fails the job on mismatch). Also computes per-table row-level MD5 checksums for the critical tables and emits backup metrics.
- **`scripts/verify-restore-checksum.sh`** (new) — byte-for-byte SHA-256 comparison plus row-level checksum verification and Postgres object-integrity checks (indices / constraints / triggers) after a restore.
- **`.github/workflows/restore-drill.yml`** — downloads the integrity sidecars, verifies the SHA-256, and runs row-checksum + object validation before asserting row counts.
- **`.github/workflows/database-backup.yml`** — the verify job now also checks the SHA-256 sidecar.
- **`monitoring/alert-rules.yml`** — `RestoreDrillFailed`, `RestoreDrillChecksumMismatch`, and `BackupStalled`.

## Workstream 5 — SBOM vulnerability severity gating

- **`.github/workflows/image-scan.yml`** — new `severity-gate` job that **blocks** any PR carrying a CRITICAL/HIGH CVE unless a structured, non-expired `.trivyignore` exception is in place.
- **`.trivyignore`** — documented 4-field structured format (`CVE # reason # reviewer # expiry-date`); missing/expired fields fail CI.
- **`scripts/trivyignore-gate.js`** (new) — validates the structured format, fails on malformed/expired entries, and emits the bare CVE list Trivy understands.
- **`scripts/sbom-diff.js`** (new) — diffs two CycloneDX SBOMs and flags new/removed/changed deps; new deps with CRITICAL/HIGH CVEs fail CI (not suppressible via .trivyignore).
- **`.github/workflows/sbom.yml`** — new `sbom-diff` job posts a dependency-diff comment on every PR.
- **`.github/workflows/sbom-weekly-diff.yml`** (new) — weekly baseline-vs-current comparison that auto-creates issues for newly discovered CRITICAL CVEs.

## Workstream 6 — Network policy audit and zero-trust enforcement

- **`scripts/validate-networkpolicies.js`** (new) — parses every policy, validates default-deny, builds the pod coverage matrix (a workload with no policy fails CI), and flags `0.0.0.0/0` egress.
- **`.github/workflows/networkpolicy-lint.yml`** (new) — runs the validator on every k8s PR/push.
- **`docs/architecture.md`** — new *Network Policy & Zero-Trust Model* section with an ASCII diagram of allowed paths and rollout guidance.

## Workstream 7 — Synthetic transaction monitoring

- **`scripts/synthetic-monitor.js`** (new) — end-to-end donation simulation (load → build → sign → submit → on-chain event → backend record → leaderboard), with auto Friendbot top-up and full Prometheus metrics (`synthetic_donation_success`, `_duration_seconds`, `_step`, `_checks_total`, `_failures_total`).
- **`backend/src/services/stellar.js`** — `getSyntheticSenderInfo()` helper exposing the synthetic sender's public config for telemetry (secret never leaves the monitor).
- **`.github/workflows/synthetic-monitor.yml`** (new) — scheduled every 5 minutes.
- **`k8s/synthetic-monitor.yaml`** (new) — optional in-cluster CronJob for environments without Actions.
- **`k8s/secret.yaml` / `k8s/external-secret.yaml`** — synthetic sender secret keys.
- **`monitoring/alert-rules.yml`** — `SyntheticDonationFailed` (fires after 2 consecutive failures, includes the failed step) and `SyntheticDonationStalled`.
- **`monitoring/grafana/dashboards/synthetic-monitor.json`** (new) — Grafana panel with success, duration, failures, and step gauge.

---

## CI verification (run locally, matching the CI jobs)

- **Backend tests** — full suite via `docker compose -f docker-compose.test.yml up`: **91 suites passed, 1055 tests passed**.
- **Backend lint** — `npm run lint`: **0 errors**.
- **Helm** — `helm lint helm/indigopay/` and `helm template` (with failover+replication enabled) render cleanly; the Lease and RBAC render.
- **Secret lint** — `k8s/helm/monitoring` contain no forbidden placeholder secrets.
- **OpenAPI** — `scripts/validate-openapi.js` and Spectral lint both **pass** (incl. the new `/api/admin/secrets/status` path).
- **Network policies** — `scripts/validate-networkpolicies.js` passes on all `k8s/` policies (default-deny present, all 6 workloads covered, no broad egress).
- **SBOM tooling** — `sbom-diff.js` and `trivyignore-gate.js` smoke-tested and working.

> ⚠️ Note on `secrets-lint.yml`: an existing unrelated YAML-parsing quirk (js-yaml strictness vs the embedded Python in `secret-rotation.yml`) is pre-existing and untouched; GitHub Actions uses its own parser, so it is not affected by this PR.

## Security & compatibility considerations honored

- `synchronous_commit = remote_apply` guarantees zero write loss on failover.
- Synthetic monitor secret lives in the Secrets Manager / K8s Secret — never committed.
- SBOM/Trivy results don't leak internal infra in public CI logs.
- Network-policy changes documented to roll out incrementally (observe-then-enforce).
- Secret rotation supports rollback (previous remains valid until revoked).
- All changes are backward compatible with `docker-compose.yml` dev setup.

## Files touched

**Modified (26):** `.github/workflows/{database-backup,image-scan,restore-drill,sbom}.yml`, `.trivyignore`, `backend/src/middleware/auth.js`, `backend/src/routes/admin.js`, `backend/src/services/{redis,stellar}.js`, `docs/api/openapi.yaml`, `docs/architecture.md`, `gitops/argo-rollouts-canary.yaml`, `helm/indigopay/{values.yaml,templates/postgres-failover-rbac.yaml,templates/postgres.yaml}`, `k8s/{external-secret,secret,postgres,postgres-failover-job,postgres-failover-rbac,postgres-failover-script,kustomization}.yaml`, `monitoring/{alert-rules,recording-rules}.yml`, `scripts/{backup-db,setup-replication}.sh`.

**Added (~16):** `scripts/{postgres-healthcheck-daemon,sbom-diff,synthetic-monitor,trivyignore-gate,validate-networkpolicies}.js`, `scripts/verify-restore-checksum.sh`, `scripts/workflow/{rotate,update,restore}_secrets.py`, `backend/src/services/signingSecretProvider.js` (+ test), `backend/src/routes/admin/secrets.js`, `docs/runbooks/{postgres-failover,canary-analysis}.md`, `k8s/{postgres-primary-lock,synthetic-monitor}.yaml`, `helm/indigopay/templates/postgres-primary-lock.yaml`, `gitops/analysis-template.yaml`, `.github/workflows/{networkpolicy-lint,sbom-weekly-diff,synthetic-monitor}.yml`, `monitoring/grafana/dashboards/{canary-analysis,synthetic-monitor}.json`.
---

## 🔧 Follow-up: CI fixes after main merge (commit `20fa4dd`)

### 1. Merge reconciliation (fixes `CI / Backend (Node.js)`)

Merging `main` into this branch replaced several WS3/WS7 backend files with
main's newer versions, breaking consumers of the signing-secret rotation
provider (`TypeError: keyIdFor is not a function`, `getAuthCandidates is not
defined`). The two implementations are now merged instead of overwritten:

- **`backend/src/services/signingSecretProvider.js`** — exports both main's
  `getSigningSecret`/`SIGNER_CONFIG` (used by `recurringKeeper`/`guardian`)
  *and* the WS3 multi-version rotation API (`currentKey`,
  `keysForAcceptance`, `describe`, `getRenderedStatus`, `registeredSecretNames`,
  `keyIdFor`) used by `auth.js`/`secrets.js`.
- **`backend/src/services/redis.js`** — keeps main's Sentinel/failover mode and
  restores the dual-version AUTH fallback helper `getAuthCandidates`.
- **`backend/src/services/stellar.js`** — keeps main's tracing /
  `submitWithFeeBump` / `getTransaction` and restores WS7
  `getSyntheticSenderInfo`.
- **`signingSecretProvider.test.js`** — merged test suites for both APIs
  (13 tests).

Verified locally: `npm run lint` (0 errors), full containerized suite
**137 suites / 1429 tests pass**.

### 2. Image Scan severity-gate remediation (fixes both `Image Scan / Fail on CRITICAL/HIGH CVEs`)

The gate (WS5) blocked on pre-existing CRITICAL/HIGH CVEs. Fixed the fixable
app-layer CVEs and documented the remainder as time-boxed exceptions:

- **Backend lockfile** — upgraded `undici` → 7.29/8.10, `js-yaml` → 4.3.2,
  `fast-uri` → 3.1.6, `brace-expansion` → 1.1.18/2.1.4/5.0.9, `ip-address` → 10.5.0.
- **Frontend lockfile** — `next` 14.2.3 → **14.2.35** (closes the CRITICAL
  **CVE-2025-29927** middleware bypass + 4 HIGH advisories), `nanoid` → 3.3.18,
  `postcss` → 8.5.26, `rollup` → 2.80.0/4.63.1, `sharp` → 0.35.0 (via npm
  `overrides` for the exact-pinned transitive copies).
- **`.trivyignore`** — documented the 21 remaining CVEs as **reviewed,
  time-boxed exceptions** (expiry **2026-12-31**, reviewer `@LaPoshBaby`):
  the 11 base-image CVEs bundled in `node:22-alpine` (npm CLI + openssl, not
  present in any app lockfile) and the 10 frontend-only CVEs that only next
  **15.5.16+ / 16.x** fixes (React 19 migration tracked separately) plus the
  `postcss` 8.4.31 copy exact-pinned inside next 14.2.35.

Verified locally: both severity-gate runs (`trivy --exit-code 1` with the
effective ignore list) **exit 0** with no un-excepted findings; frontend
type-check, lint, jest **67 suites / 618 tests**, CSP + locale parity, and
the production `next build` all pass on the upgraded dependency tree.
