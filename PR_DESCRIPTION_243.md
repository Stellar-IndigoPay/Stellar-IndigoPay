# Automated CO₂ Offset Rate Verification with Independent Data Pipeline

**Closes #243**

## Summary

Builds an automated pipeline that verifies project-reported CO₂ offset rates against independent scientific databases and satellite-based biomass estimation. Projects whose claimed `co2_per_xlm` rates deviate significantly from independent estimates are flagged and surfaced in the admin dashboard and on project detail pages.

Previously, CO₂ rate verification relied exclusively on static per-category benchmarks (`CATEGORY_BENCHMARKS`) and required manual admin review. A project could claim `MAX_CO2_PER_XLM` (100,000 g/XLM) when the scientifically-validated rate for that category and location might be 500 g/XLM. This PR introduces a multi-source automated verification pipeline with confidence band computation, severity grading, audit trail persistence, and a weekly cron schedule.

## Changes

### New Files

| File | Purpose |
|------|---------|
| `backend/src/db/migrations/023_co2_verification_runs.js` | New `co2_verification_runs` table tracking every automated verification run with claimed rate, confidence band, reference/satellite sources, and flag reason |
| `PR_DESCRIPTION_243.md` | PR description file |

### Modified Files

| File | Change |
|------|--------|
| `backend/src/services/co2Verifier.js` | Major enhancement: external API integration (Gold Standard, Verra, IPCC fallback), satellite data (Global Forest Watch, IPCC tier-1 climate zones), confidence band computation, severity grading, full `verifyProjectCO2Rate()` pipeline, `runVerificationForAllProjects()` batch processor, pg-boss cron scheduler, Prometheus `indigopay_co2_verifications_total` counter. Backward-compatible — existing `verifyCO2Rate()` and `applyCO2VerificationToProject()` preserved. |
| `backend/src/routes/admin/co2.js` | Added `POST /verify-all` (batch trigger), `POST /verify/:projectId` (single-project), `GET /flags/:projectId/history` (audit trail). Enhanced `GET /flags` with LATERAL JOIN to surface confidence band, deviation %, severity, and reference source per row. Added audit logging for all new actions. |
| `backend/src/server.js` | Bootstrapped `startCO2VerificationCron()` in `startServer()`, registered lifecycle shutdown handler, added `co2Verifier` to pg-boss drain list. |
| `frontend/pages/admin/co2-flags.tsx` | Added columns: Confidence Band, Deviation % (color-coded), Reference Source. Added Re-verify button per project and Re-verify All Projects button with summary results banner. |
| `frontend/pages/projects/[id].tsx` | Added CO₂ Rate Verification section with green/amber/red status badges and link to transparency methodology page. |
| `backend/src/services/co2Verifier.test.js` | Rewrote from 12 to **45 tests** covering: original benchmark comparison, external API fallback chains (Gold Standard + Verra), satellite data (GFW + IPCC zones), confidence band computation, severity thresholds, full pipeline, batch verification, cron scheduling, IPCC constants. |
| `docs/architecture.md` | Added Automated CO₂ Offset Rate Verification section with pipeline diagram, reference source hierarchy, satellite data integration, confidence band & severity table, scheduled verification docs. Added "Inflated CO₂ rates" row to security table. |

## Architecture

### Verification Pipeline

```
Project registered ──► verifyProjectCO2Rate(project)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            fetchReferenceRates()   fetchSatelliteEstimate()
            ┌───────────────────    ┌───────────────────────
            │1. Gold Standard API   │1. Global Forest Watch API
            │2. Verra VCS API       │2. IPCC tier-1 (tropical/
            │3. Static Benchmarks   │   temperate/boreal zone)
            │4. IPCC fallback       └───────────────────────
            └───────────────────               │
                    │                          │
                    └───────────┬──────────────┘
                                ▼
                    computeConfidenceBand()
                    [lower, upper] g CO₂/XLM
                                │
                                ▼
                    computeSeverity()
                    none / warning / critical
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          co2_verification_runs     projects.co2_verification_status
          (immutable audit log)     (updated if warning/critical)
```

### Reference Rate Source Hierarchy

| Priority | Source | Configuration | Fallback |
|----------|--------|---------------|----------|
| 1 | Gold Standard Impact Registry | `CO2_VERIFIER_GS_API_URL` | → Priority 2 |
| 2 | Verra VCS Registry | `CO2_VERIFIER_VERRA_API_URL` | → Priority 3 |
| 3 | IndigoPay Category Benchmarks | Built-in | → Priority 4 |
| 4 | IPCC Tier-1 Emission Factors | Built-in | (terminal) |

### Confidence Band & Severity

| Severity | Condition | Admin Action | DB Status |
|----------|-----------|-------------|-----------|
| none | rate ≤ upper × 1.5 | None (plausible) | unchanged |
| warning | upper × 1.5 < rate ≤ upper × 3.0 | Review recommended | `review` |
| critical | rate > upper × 3.0 | Admin resolution required | `flagged` |

### New Database Table

```sql
CREATE TABLE co2_verification_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    claimed_rate     INTEGER NOT NULL,
    confidence_lower INTEGER NOT NULL,
    confidence_upper INTEGER NOT NULL,
    is_plausible     BOOLEAN NOT NULL,
    reference_source VARCHAR(255) NOT NULL,
    satellite_source VARCHAR(255),
    flag_reason      TEXT,
    verified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_co2_verification_project
    ON co2_verification_runs (project_id, verified_at DESC);
```

### New Admin API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/flags/:projectId/history` | admin | Full verification run history |
| `POST` | `/verify-all` | admin | Trigger verification for all active projects |
| `POST` | `/verify/:projectId` | admin | Trigger verification for single project |

### Cron Scheduling

- **Default:** Every Sunday at 03:00 UTC (`0 3 * * 0`)
- **Override:** `CO2_VERIFICATION_CRON` env var or `"disabled"` to turn off
- **Concurrency:** Sequential processing (`teamSize: 1`, `teamConcurrency: 1`)

### Prometheus

- **`indigopay_co2_verifications_total`** — Counter labelled by `outcome` (`plausible`, `warning`, `critical`, `error`)

## Acceptance Criteria

- ✅ Verifier runs for all active projects and produces `co2_verification_runs` rows
- ✅ Reforestation projects in Brazil receive satellite-informed confidence band (IPCC tropical: 11.0 tCO₂/ha/yr)
- ✅ Project with inflated rate flagged (severity: critical when >3× upper bound)
- ✅ Project with plausible rate passes verification
- ✅ Verification results cached and re-verified weekly via cron
- ✅ Admin CO₂ flags page shows confidence bands and reference sources
- ✅ Project detail page shows verification status (✅ verified / 🚩 flagged / ⚠️ review)
- ✅ Prometheus metric increments per run

## Testing

- ✅ **45/45 backend unit tests passing** — benchmark comparison, external API fallback chains, satellite data, confidence bands, severity, pipeline, batch, cron, IPCC constants
- ✅ **ESLint: 0 errors** (7 pre-existing warnings in server.js only)
- ✅ All external API calls mocked in tests
- ✅ Backward compatibility preserved

## Deployment Notes

1. Run migration `023_co2_verification_runs`
2. Optional env vars for external APIs (all gracefully degrade):
   - `CO2_VERIFIER_GS_API_URL`, `CO2_VERIFIER_VERRA_API_URL` — registry APIs
   - `CO2_VERIFIER_GFW_API_URL`, `CO2_VERIFIER_GFW_API_KEY` — satellite data
   - `CO2_VERIFICATION_CRON` — cron schedule (default: `0 3 * * 0`)
3. No new npm dependencies required
4. First run: `POST /api/v1/admin/co2/verify-all` to populate initial data
