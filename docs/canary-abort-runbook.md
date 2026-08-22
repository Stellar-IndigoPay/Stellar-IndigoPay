# Backend Canary Auto-Abort Runbook

`gitops/argo-rollouts-canary.yaml` runs a background AnalysisRun
against Prometheus for every backend release. If it fails, Argo
Rollouts **already rolled the canary back automatically** by the time
you see the page — this runbook is about triage, not recovery.

## What happened

1. A new backend revision started rolling out via the `Rollout`
   (20% → 50% → 100%, `k8s/backend.yaml`'s `Deployment` is replaced
   by this `Rollout`).
2. The `backend-success-rate` `AnalysisTemplate` polled Prometheus
   every 60s and got `< 0.99` success rate on 2 checks
   (`failureLimit: 2`), or the query itself failed.
3. Argo Rollouts set the analysis to `Failed` and auto-aborted the
   `Rollout`. Canary pods were scaled down after
   `abortScaleDownDelaySeconds` (30s); `backend-svc` already routes
   100% of traffic to the `stable` revision.
4. `CanaryRolloutAborted` fired (severity: page) from
   `monitoring/alert-rules.yml`.

## Triage steps

1. **Confirm stable is healthy**: `kubectl get rollout backend -n
   stellar-indigopay` — `status.phase` should already read
   `Degraded`/`Paused` and `status.stableRS` should be serving.
2. **Find the failing revision**: `kubectl argo rollouts get rollout
   backend -n stellar-indigopay` shows the aborted `ReplicaSet` and
   its image tag.
3. **Check why analysis failed**: `kubectl argo rollouts get
   analysisrun -n stellar-indigopay` for the run tied to the aborted
   revision, then check Sentry/logs for that revision's pods.
4. **Do not re-apply the same image** until the regression is fixed
   — the next rollout will re-run analysis from step 0 and abort
   again if the bug is still present.

## Manual escalation

If the `Rollout` does not show `stable` serving traffic within a few
minutes of the alert (controller down, CRD issue), fall back to the
manual rollback documented at the top of
`gitops/argo-rollouts-canary.yaml` — delete the bad `ReplicaSet` and
scale `stable` to `spec.replicas` directly.
