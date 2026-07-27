# Performance Targets

## POST /api/donations

| Metric                 | Target      |
| ---------------------- | ----------- |
| p50 latency            | < 150 ms    |
| p95 latency            | < 500 ms    |
| p99 latency            | < 1 000 ms  |
| Error rate             | < 1 %       |
| Throughput (sustained) | ≥ 100 req/s |

These targets are validated by the k6 load test at `scripts/load-test.js`
(100 virtual users × 60 seconds). The p95 < 500 ms threshold is enforced as
a hard k6 `thresholds` check; the test exits with a non-zero status if it
is violated.

## Indexer SLOs

- Indexer lag should stay below 50 ledgers under normal operation.
- Autonomous backfills should recover from lag within 60 seconds for deviations of 10+ ledgers.
- The readiness endpoint should surface indexer degradation when lag exceeds 50 ledgers.

## Running the test

```bash
# Install k6: https://k6.io/docs/get-started/installation/
# brew install k6  (macOS)

# Against local dev server (default port 4000)
k6 run scripts/load-test.js

# Against a staging environment
BASE_URL=https://staging.stellarindigopay.com k6 run scripts/load-test.js

# Ramp-up scenario (0 → 100 VUs over 30 s, hold 60 s, ramp down)
SCENARIO=ramp-up k6 run scripts/load-test.js

# Save raw metrics as JSON for later analysis
k6 run --out json=results.json scripts/load-test.js
```

### npm shortcut

```bash
cd backend
npm run load-test                                     # sustained (default)
BASE_URL=https://staging.stellarindigopay.com npm run load-test
SCENARIO=ramp-up npm run load-test
```

## Understanding the thresholds

| Threshold                         | k6 expression | Meaning                                    |
| --------------------------------- | ------------- | ------------------------------------------ |
| `donation_latency p(95)<500`      | Hard          | 95 % of requests must complete in < 500 ms |
| `donation_success_rate rate>0.99` | Hard          | ≥ 99 % of checks must pass                 |
| `http_req_failed rate<0.01`       | Hard          | HTTP error rate must stay below 1 %        |

A failed threshold causes k6 to exit with a non-zero status, which will fail the CI job.

## Interpreting results

After a run k6 prints a summary like:

```
donation_latency.........: avg=82ms  min=12ms  med=74ms  max=490ms  p(90)=140ms p(95)=210ms
http_reqs................: 5 823  96.99/s
```

Key columns to watch:

- **p(95)** — must stay under 500 ms per threshold
- **http_reqs / rate** — sustained throughput; target ≥ 100 req/s
- **http_req_failed** — any non-zero value here warrants investigation

## Baseline results (testnet, 2026-06-02)

_Run after initial backend deployment. Update this table after each significant
infrastructure change or after merging changes to the donations route._

| Metric     | Result |
| ---------- | ------ |
| p50        | — ms   |
| p95        | — ms   |
| p99        | — ms   |
| Error rate | — %    |
| Peak RPS   | —      |

> Fill in actual numbers by running `npm run load-test` against the target environment
> and copying the summary output here before merging backend changes that touch the
> donations route or the Stellar submission path.

## SLO Definitions

Stellar IndigoPay defines Service Level Objectives (SLOs) for its two critical user
journeys. These SLOs are measured over a rolling 30-day window and are enforced via
multi-window burn-rate alerts (see [Burn-Rate Alert Response](#burn-rate-alert-response)).

| SLO                         | Target    | Error Budget | Error Definition                                      |
| --------------------------- | --------- | ------------ | ----------------------------------------------------- |
| Donation recording          | 99.5%     | 0.5%         | Any 5xx response on `POST /api/donations`            |
| Project listing             | 99.9%     | 0.1%         | Any 5xx response OR >2s latency on `GET /api/projects` |

Recording rules that pre-compute error ratios are defined in
`monitoring/recording-rules.yml`. The metrics exposed are:

* `slo:donations:error_ratio` — 1-minute sliding error ratio for donations
* `slo:projects:error_ratio` — 1-minute sliding error ratio for project listing
* `slo:donations:error_budget_remaining_pct` — remaining error budget as a percentage
* `slo:projects:error_budget_remaining_pct` — remaining error budget for projects

### Burn-Rate Alert Response

Burn-rate alerts follow the Google SRE Workbook multi-window approach. Three windows
detect different failure modes:

| Alert                         | Burn Rate | Window | Severity | Meaning                                        |
| ----------------------------- | --------- | ------ | -------- | ---------------------------------------------- |
| DonationsHighBurnRate1h       | 14.4x     | 1h     | page     | 2% of 30-day error budget burned in 1 hour     |
| DonationsHighBurnRate6h       | 6.0x      | 6h     | page     | 5% of 30-day error budget burned in 6 hours    |
| DonationsHighBurnRate3d       | 1.0x      | 3d     | warn     | 10% of 30-day error budget burned in 3 days    |
| ProjectsHighBurnRate1h        | 14.4x     | 1h     | page     | 2% of 30-day error budget burned in 1 hour     |
| ProjectsHighBurnRate6h        | 6.0x      | 6h     | page     | 5% of 30-day error budget burned in 6 hours    |
| ProjectsHighBurnRate3d        | 1.0x      | 3d     | warn     | 10% of 30-day error budget burned in 3 days    |

**When `DonationsHighBurnRate1h` fires:**

1. Acknowledge the page within 5 minutes.
2. Post in the `#incidents` Slack channel with the alert summary.
3. Check Soroban RPC health: `stellar network health` or the Horizon `/health` endpoint.
4. Check the Postgres connection pool: review the Grafana dashboard → Database → Pool panels.
5. Check for recent deployments: `git log --oneline -5` and correlate with the alert start time.
6. Inspect Sentry for recent 5xx error spikes.
7. If the alert resolves on its own within 10 minutes, it may be a transient Soroban RPC
   issue — create a low-priority ticket to investigate the RPC provider's status.

**When any burn-rate alert fires at severity `page`:**

1. Acknowledge within 5 minutes.
2. Post in `#incidents` Slack channel.
3. Check the Grafana dashboard (`Stellar IndigoPay — Backend`) → SLO Error Budget panel
   to assess current burn rate.
4. Cross-reference with the [deployment history](https://github.com/stellar-indigopay/indigopay/deployments).

**Escalation criteria:**

* If error budget exceeds 50% consumed within any rolling 7-day window, schedule an
  engineering review within 24 hours.
* If the error budget is fully exhausted (< 5% remaining), escalate to the engineering
  lead and consider freezing deployments until the root cause is identified.

**Silencing burn-rate alerts:**

Do NOT silence burn-rate alerts for more than 1 hour without an active incident. Silencing
masks real error budget consumption. If you must silence (e.g., during planned maintenance),
create an Alertmanager silence with a clear comment and a fixed expiry.

## CI integration

Add the following step to `.github/workflows/ci.yml` to run the load test against a
short smoke profile on every PR that touches `backend/src/routes/donations.js`:

```yaml
- name: Install k6
  run: |
    curl -s https://dl.k6.io/key.gpg | sudo apt-key add -
    echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
    sudo apt-get update && sudo apt-get install k6

- name: Donation route smoke load test
  run: k6 run --vus 10 --duration 10s scripts/load-test.js
  env:
    BASE_URL: http://localhost:4000
```
