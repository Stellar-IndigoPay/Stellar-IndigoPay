# Runbook: Argo CD Canary Analysis

Part of issue **#1100 — Workstream 2**: automated, metric-driven canary
promotion and rollback using Argo Rollouts `AnalysisTemplate` against real
Prometheus metrics — no manual review required.

## Overview

The backend is deployed as an Argo `Rollout` (see
`gitops/argo-rollouts-canary.yaml`). On each release it rolls through stepped
weights (20% → 50% → 100%). Before each promotion step Argo Rollouts runs the
canary `AnalysisTemplate` (`gitops/analysis-template.yaml`) which queries
Prometheus every 30 s for a 10-minute window:

| Metric | Condition to pass |
|---|---|
| Canary error rate | must not exceed **1.5×** the stable error rate |
| Canary p95 latency | must not increase by more than **20%** over stable |

- **On `Failed`** → Argo Rollouts aborts, traffic reverts to stable, and the
  rollout reports `Degraded`.
- **On `Successful`** → Argo Rollouts promotes to the next canary step,
  ultimately taking 100%.

The error-rate and p95 inputs are pre-computed by Prometheus recording rules in
`monitoring/recording-rules.yml` (`canary_error_rate`, `stable_error_rate`,
`canary_p95_latency`, `stable_p95_latency`), so the AnalysisTemplate's success
conditions are simple scalar comparisons. The Grafana dashboard
`monitoring/grafana/dashboards/canary-analysis.json` renders canary-vs-stable
during a live rollout.

## Prerequisites

- Argo Rollouts installed in the cluster
  (`kubectl create ns argo-rollouts && kubectl apply -n argo-rollouts -f .../install.yaml`).
- Prometheus reachable at `http://prometheus-operated.monitoring.svc:9090`
  (adjust via the `prometheus-address` arg if your operator runs elsewhere).
- Backend HTTP metrics carry a `version` label equal to `canary` or `stable`.
  If they do not, add it (see `backend/src/services/metrics.js`) — the queries
  are keyed on `version`.

## When to use this runbook

- You observe a canary rollout that rolled back unexpectedly (`Degraded`).
- You want to understand why a rollout paused at a canary step.
- You are certifying that a new backend release is healthy at 100%.

## Step 1 — Observe a rollout

```bash
kubectl argo rollouts get rollout backend -n stellar-indigopay --watch
```

You will see the analysis runs at each weight step and their pass/fail status.

## Step 2 — Inspect the analysis runs

```bash
kubectl get analysisruns -n stellar-indigopay
kubectl get analysisrun <name> -n stellar-indigopay -o yaml
```

Look at `.status.metricResults[].status` and `.status.phase`:
- `Successful` — promote.
- `Failed` — rollback.
- `Inconclusive` — check the metric queries; often no `version` label.

## Step 3 — Confirm which metric failed

```bash
kubectl describe analysisrun <name> -n stellar-indigopay
```

Cross-reference with the Grafana canary dashboard: check whether `canary_error_rate`
crossed the 1.5× threshold or `canary_p95_latency` exceeded 1.2× stable.

## Step 4 — Validate the Prometheus queries directly

Run the AnalysisTemplate's queries in the Prometheus UI (or `promtool query`):

```promql
# Canary error rate
sum(rate(http_requests_total{version="canary",status=~"5.."}[5m]))
  / clamp_min(sum(rate(http_requests_total{version="canary"}[5m])), 0.001)
```

## Step 5 — Healthy promotion

If both metrics are within threshold, the rollout graduates to 100% and
reports `Success`. No action required.

## Step 6 — Handling a genuine rollback

1. Identify the offending release (git SHA / image tag) from the rollout.
2. Fix the regression, rebuild, and redeploy — the next rollout will re-run
   canary analysis from scratch.
3. Do **not** force-promote a failing canary; the analysis exists precisely to
   keep a broken revision off 100% traffic.

## Validation (CI)

- `helm lint helm/indigopay/` and `helm template` validate Rollout + AnalysisTemplate
  syntax (the helm chart includes `gitops/analysis-template.yaml`).
- `monitoring/recording-rules.yml` is validated with:
  ```bash
  promtool check rules monitoring/recording-rules.yml
  ```

## Notes / pitfalls

- The `version` label is required. If a rollout uses pod-template-hash labels
  instead, update the queries `{version="canary"}` to the label you use.
- The recording rules guard division by zero with `clamp_min(..., 0.001)` so a
  quiet rollout (no traffic) yields a defined error rate instead of `NaN`.