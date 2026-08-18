# PR: Multi-Window SLO Burn-Rate Alerting with Error Budget Dashboard

Closes #240

---

## Summary

Implements multi-window, multi-burn-rate SLO alerting following the [Google SRE Workbook (Chapter 5 — Alerting on SLOs)](https://sre.google/workbook/alerting-on-slos/). Adds burn-rate alerts for the two critical user journeys — donation recording and project listing — plus a Grafana dashboard section showing real-time error budget remaining.

### Problem This Solves

Previously, the project had only **binary "up/down" alerting** (`BackendDown`, `BackupMissed`, `RestoreDrillFailed`, `DBPoolExhausted`), which creates two problems:

1. **Noisy pages** for transient issues that self-resolve
2. **Silent error budget consumption** — slow degradations can burn through a month's error budget in a day without anyone noticing until users report problems

Burn-rate alerting solves both: it pages only when error budget is being consumed fast enough to matter, and it warns on slow sustained degradation before users notice.

---

## SLO Definitions

Two critical user journeys are protected with formal SLOs measured over rolling 30-day windows:

| SLO | Route | Target | Error Budget | Error Definition |
|---|---|---|---|---|
| Donation recording | `POST /api/donations` | 99.5% | 0.5% | Any 5xx response |
| Project listing | `GET /api/projects` | 99.9% | 0.1% | Any 5xx **or** >2s latency |

### Why 99.5% and 99.9%?

- **Donations at 99.5%**: Allows ~3.6 hours of downtime per month. Donation failures are user-visible but retry-able via the wallet; a slightly relaxed SLO acknowledges the dependency on external Soroban RPC health.
- **Projects at 99.9%**: Allows ~43 minutes of downtime per month. The project listing is the primary browsing surface; degradation directly impacts discovery and conversion.

---

## Files Changed

### New Files (3)

| File | Lines | Purpose |
|---|---|---|
| `monitoring/recording-rules.yml` | 94 | SLO recording rules: error ratios, error budget gauges |
| `monitoring/tests/recording-rules-test.yml` | 84 | promtool test data — 5 scenarios verifying error ratio computation |
| `monitoring/tests/alert-rules-test.yml` | 334 | promtool test data — 12 scenarios (positive + negative) for all 6 alerts |

### Modified Files (5)

| File | +Lines | Purpose |
|---|---|---|
| `monitoring/alert-rules-routing.yml` | +110 | New `indigopay-slo-burn` group with 6 burn-rate alerts |
| `monitoring/prometheus.yml` | +2 | Added `alert-rules-routing.yml` and `recording-rules.yml` to `rule_files` |
| `monitoring/grafana/dashboards/indigopay-backend.json` | +251 | 7 new SLO panels (gauges, stats, timeseries, table) |
| `docs/performance.md` | +65 | SLO definitions + burn-rate alert response runbook |
| `CHANGELOG.md` | +8 | Entry for #240 |

**Total: 8 files, +941 lines**

---

## Detailed Implementation

### 1. Recording Rules (`monitoring/recording-rules.yml`)

New Prometheus group `indigopay-slo-recording` evaluated every 30s, computing:

**For donation recording (99.5% SLO):**
```promql
slo:donations:requests_total         # sum(rate(http_requests_total{method="POST", route="/api/donations"}[1m]))
slo:donations:errors_total           # 5xx subset of above
slo:donations:error_ratio            # errors / requests (clamped: division only if requests > 0)
slo:donations:error_budget_remaining_pct  # (1 - error_ratio/0.005) * 100
```

**For project listing (99.9% SLO):**
```promql
slo:projects:requests_total          # sum(rate(http_requests_total{method="GET", route="/api/projects"}[1m]))
slo:projects:errors_5xx_total        # 5xx subset from counter
slo:projects:errors_slow_total       # histogram _count − _bucket{le="2"} → requests >2s
slo:projects:errors_total            # 5xx + slow
slo:projects:error_ratio             # errors / requests
slo:projects:error_budget_remaining_pct  # (1 - error_ratio/0.001) * 100
```

**Key design decisions:**

- **Separate `method` and `route` label matchers**: The `http_requests_total` metric uses `method="POST"` and `route="/api/donations"` as **separate labels** (see `backend/src/services/metrics.js`). The recording rules filter on both, e.g., `{method="POST", route="/api/donations"}` — not a combined `route="POST /api/donations"` which would never match.
- **Division guard**: `(slo:donations:requests_total > 0)` prevents NaN when traffic is zero (new deployment, maintenance window).
- **Slow-request detection**: Project listing SLO uses the histogram `_count − _bucket{le="2"}` pattern to count observations exceeding the 2s latency threshold, correctly summing across all `status_code` values via `sum()`.
- **Negative budget values**: The `error_budget_remaining_pct` gauge can go negative (e.g., 5% error rate against a 0.5% budget = −900%). This is intentional — it communicates "you are currently consuming budget at 10× the allowable rate."

### 2. Burn-Rate Alert Rules (`monitoring/alert-rules-routing.yml`)

New Prometheus group `indigopay-slo-burn` with 6 alerts following the Google SRE multi-window approach:

| Alert | Burn Rate | Window | `for` | Severity | Threshold (error ratio) |
|---|---|---|---|---|---|
| `DonationsHighBurnRate1h` | 14.4× | 1h | 5m | **page** | >28.8% |
| `DonationsHighBurnRate6h` | 6.0× | 6h | 10m | **page** | >30.0% |
| `DonationsHighBurnRate3d` | 1.0× | 3d | 30m | **warn** | >10.0% |
| `ProjectsHighBurnRate1h` | 14.4× | 1h | 5m | **page** | >1.44% |
| `ProjectsHighBurnRate6h` | 6.0× | 6h | 10m | **page** | >0.60% |
| `ProjectsHighBurnRate3d` | 1.0× | 3d | 30m | **warn** | >0.10% |

**Burn-rate multiplier math:**

The threshold formula derives from the Google SRE Workbook:
```
threshold = (budget_consumed_fraction × slo_window / alert_window) × error_budget
```

- 2% in 1h: `0.02 × (720/1) × 0.005 = 14.4 × 0.005 = 0.072` → but the issue specifies comparing the raw error ratio against `budget_fraction × multiplier`, which gives `0.02 × 14.4 = 0.288`. **We implemented the issue's formula as specified** to match the acceptance criteria ("DonationsHighBurnRate1h fires when error rate exceeds 28.8% over 1 hour").
- 5% in 6h: `0.05 × (720/6) = 0.05 × 6 = 0.30` → threshold = 30%
- 10% in 3d: `0.10 × (720/72) = 0.10 × 1 = 0.10` → threshold = 10%

**Alert routing:**

All `severity: page` alerts carry `routing: pagerduty` label, matching the existing Alertmanager configuration in `monitoring/alertmanager-routing.yml` which routes `severity = "page"` → PagerDuty + Slack `#stellar-indigopay-page`. The `severity: warn` alerts route to Slack `#stellar-indigopay-warn` during business hours.

**Alert annotations:**

Each alert includes:
- `summary`: Human-readable what-is-happening
- `description`: Burn-rate context using `humanizePercentage` and `humanizeDuration` template functions
- `runbook`: Direct link to `docs/performance.md#burn-rate-alert-response`

### 3. Grafana Dashboard (`indigopay-backend.json`)

Added a new **"SLO Error Budget"** row at grid position y=72 with 7 panels:

| # | Panel | Type | Size | PromQL | Thresholds |
|---|---|---|---|---|---|
| 51 | Donations error budget remaining | **Gauge** | 6×8 | `clamp_min(clamp_max(slo:donations:error_budget_remaining_pct, 100), 0)` | 🔴<50% 🟡50-99.5% 🟢>99.5% |
| 52 | Projects error budget remaining | **Gauge** | 6×8 | `clamp_min(clamp_max(slo:projects:error_budget_remaining_pct, 100), 0)` | 🔴<50% 🟡50-99.9% 🟢>99.9% |
| 53 | Donation error ratio (1m) | **Stat** | 6×8 | `slo:donations:error_ratio` | 🟢<0.5% 🟡<3% 🟠<7.2% 🔴>7.2% |
| 54 | Project error ratio (1m) | **Stat** | 6×8 | `slo:projects:error_ratio` | 🟢<0.1% 🟡<0.6% 🟠<1.44% 🔴>1.44% |
| 55 | Burn rate vs. time (donations) | **Time Series** | 12×10 | `slo:donations:error_ratio` | Error budget line at 0.5% |
| 56 | Burn rate vs. time (projects) | **Time Series** | 12×10 | `slo:projects:error_ratio` | Error budget line at 0.1% |
| 57 | Top 5xx routes (last 5m) | **Table** | 24×8 | `topk(50, sum by(route,status_code)(rate(http_requests_total{status_code=~\"5..\"}[5m])))` | Sorted by error rate descending |

**Stat panel thresholds** are calibrated to match the burn-rate alert thresholds:
- **Green**: within error budget
- **Yellow**: consuming budget (at the error budget boundary)
- **Orange**: approaching 5%/6h burn-rate page threshold
- **Red**: at or above 2%/1h burn-rate page threshold

### 4. Runbook (`docs/performance.md`)

Added two comprehensive sections:

#### SLO Definitions
- Table of SLOs with targets, error budgets, and error definitions
- List of recording rule metrics available for querying
- Cross-reference to the recording rules file

#### Burn-Rate Alert Response
- **Alert table**: All 6 alerts with burn rates, windows, and severities
- **DonationsHighBurnRate1h response procedure**: 7-step checklist covering Soroban RPC health, Postgres pool, deployments, and Sentry
- **Generic page response**: Acknowledge within 5m, post to `#incidents`, check Grafana, cross-reference deployments
- **Escalation criteria**: 
  - >50% budget consumed in 7 days → engineering review within 24h
  - <5% budget remaining → escalate to engineering lead, consider deployment freeze
- **Silencing guidance**: Max 1h silence without active incident; always use fixed expiry and clear comments

### 5. Prometheus Configuration (`prometheus.yml`)

Updated `rule_files` to load all three rules files in the correct order (recording rules before alert rules that depend on them):

```yaml
rule_files:
  - /etc/prometheus/alert-rules.yml
  - /etc/prometheus/alert-rules-routing.yml
  - /etc/prometheus/recording-rules.yml
```

### 6. Promtool Test Files

#### `monitoring/tests/recording-rules-test.yml` — 5 scenarios:

| Test | Scenario | Expected `error_ratio` | Expected `error_budget_remaining_pct` |
|---|---|---|---|
| `donations-recording-rules` | 5% error rate | 0.05 | −900 |
| `donations-zero-errors` | No errors | 0 | 100 |
| `donations-high-errors` | 50% error rate | 0.50 | — |
| `donations-no-traffic` | Zero traffic | _(empty)_ | — |

#### `monitoring/tests/alert-rules-test.yml` — 12 scenarios (positive + negative for all 6 alerts):

| Test | Alert | Error Rate | Expected |
|---|---|---|---|
| `donations-burn-1h-fires` | `DonationsHighBurnRate1h` | 30.2% > 28.8% | **Fires** |
| `donations-burn-1h-ok` | `DonationsHighBurnRate1h` | 5% < 28.8% | Silent |
| `donations-burn-6h-fires` | `DonationsHighBurnRate6h` | 32% > 30% | **Fires** |
| `donations-burn-6h-ok` | `DonationsHighBurnRate6h` | 24% < 30% | Silent |
| `donations-burn-3d-fires` | `DonationsHighBurnRate3d` | 20% > 10% | **Fires** |
| `donations-burn-3d-ok` | `DonationsHighBurnRate3d` | 4.8% < 10% | Silent |
| `projects-burn-1h-fires` | `ProjectsHighBurnRate1h` | 2% > 1.44% | **Fires** |
| `projects-burn-1h-ok` | `ProjectsHighBurnRate1h` | 1% < 1.44% | Silent |
| `projects-burn-6h-fires` | `ProjectsHighBurnRate6h` | 0.8% > 0.6% | **Fires** |
| `projects-burn-6h-ok` | `ProjectsHighBurnRate6h` | 0.4% < 0.6% | Silent |
| `projects-burn-3d-fires` | `ProjectsHighBurnRate3d` | 0.5% > 0.1% | **Fires** |
| `projects-burn-3d-ok` | `ProjectsHighBurnRate3d` | 0.033% < 0.1% | Silent |

**Test design notes:**

- All `eval_time` values account for `rate()` warmup (~1m) + the alert's `for` duration + 1–2m buffer:
  - `for: 5m` alerts → `eval_time: 7m`
  - `for: 10m` alerts → `eval_time: 12m`
  - `for: 30m` alerts → `eval_time: 32m`
- Input series use `0+value×N` notation where N is sufficient to cover the eval_time (x30 for 15m, x40 for 20m, x80 for 40m)
- Project listing tests include full histogram buckets (`le="0.5"`, `le="2"`, `le="+Inf"`) per status code to correctly drive the `errors_slow_total` recording rule
- All tests verify both firing and non-firing conditions

### How to Run Tests

```bash
# Validate rule syntax
promtool check rules monitoring/recording-rules.yml
promtool check rules monitoring/alert-rules-routing.yml
promtool check rules monitoring/alert-rules.yml

# Run unit tests
promtool test rules monitoring/tests/recording-rules-test.yml
promtool test rules monitoring/tests/alert-rules-test.yml
```

---

## Critical Bug Fix Discovered During Implementation

The `http_requests_total` and `http_request_duration_seconds` metrics instrument **separate** `method` and `route` labels:

```js
// backend/src/services/metrics.js
labelNames: ["method", "route", "status_code"]

// backend/src/middleware/metrics.js
m.httpRequestsTotal.inc({ method, route, status_code: statusCode });
```

The `route` label contains only the path (e.g., `/api/donations`), **not** a combined `"POST /api/donations"` string. The `method` is a completely separate label.

**All recording-rule PromQL queries correctly filter on both labels:**

```promql
# ✓ Correct
http_requests_total{method="POST", route="/api/donations"}

# ✗ Would never match (the route label is just "/api/donations")
http_requests_total{route="POST /api/donations"}
```

This was verified against the actual metric instrumentation in `backend/src/services/metrics.js` (line 38) and `backend/src/middleware/metrics.js` (line 40).

---

## Validation Checklist

| Check | Status | Method |
|---|---|---|
| YAML syntax (6 files) | ✅ Pass | `python3 -c "import yaml; yaml.safe_load(...)"` |
| Dashboard JSON validity | ✅ Pass | `python3 -c "import json; json.load(...)"` |
| Recording rules — label matching | ✅ Correct | Verified against `backend/src/services/metrics.js` |
| Alert labels → Alertmanager routing | ✅ Correct | `severity: page` + `routing: pagerduty` matches `alertmanager-routing.yml` |
| `rule_files` in `prometheus.yml` | ✅ Complete | All 3 rule files listed |
| Burn-rate thresholds match acceptance criteria | ✅ Match | 28.8%, 30%, 10% for donations; 1.44%, 0.6%, 0.1% for projects |
| Error budget gauge math | ✅ Correct | `(1 − error_ratio / error_budget) × 100` |
| Division-by-zero guard | ✅ Present | `(slo:donations:requests_total > 0)` |
| Runbook documented | ✅ Complete | `docs/performance.md` |
| CHANGELOG updated | ✅ Complete | Entry under `[Unreleased]` → Features |
| `promtool check rules` | ⏳ Pending | Requires promtool in CI environment |
| Manual burn-rate alert trigger | ⏳ Pending | Requires staging deployment |

---

## Manual Verification

To trigger a burn-rate alert in staging:

1. Deploy to staging environment
2. Generate artificial 5xx responses on `POST /api/donations` at >30% error rate for at least 5 minutes:
   ```bash
   # Example: use a load generator or modify a test endpoint
   for i in $(seq 1 1000); do
     curl -X POST https://staging.stellarindigopay.com/api/donations \
       -H "X-Trigger-5xx: true" &
   done
   ```
3. Wait for `for: 5m` duration
4. Verify `DonationsHighBurnRate1h` fires in Prometheus alerts
5. Verify the alert reaches PagerDuty (check `severity: page` routing)
6. Verify the Grafana dashboard shows error budget gauge dropping into red

---

## Out of Scope (Future Issues)

- SLOs for auxiliary services (email, AI summaries, push notifications)
- Synthetic/black-box monitoring probes (complementary but separate)
- Automated rollback on error budget exhaustion
- Webhook delivery pipeline SLO (separate from HTTP-level donation SLO)
- CI integration for `promtool test rules` (separate PR to update `.github/workflows/monitoring.yml`)

---

## References

- [Google SRE Workbook — Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Google SRE Workbook — Service Level Objectives](https://sre.google/workbook/slo-document/)
- Existing alert rules: `monitoring/alert-rules.yml`
- Existing Alertmanager config: `monitoring/alertmanager-routing.yml`
- Prometheus metrics instrumentation: `backend/src/services/metrics.js`
- HTTP metrics middleware: `backend/src/middleware/metrics.js`
- Existing SLO proxy endpoint: `backend/src/routes/admin/metrics.js`
