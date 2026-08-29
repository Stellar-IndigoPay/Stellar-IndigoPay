---
title: ArgoCD GitOps Sync Drift and Application Health Incident Response
severity: page
owners:
  - "@oncall-team"
  - "@devops-team"
symptoms:
  - "ArgoCDAppOutOfSync or ArgoCDAppDegraded alert active"
  - "Cluster resources diverge from gitops/ and helm/ manifests"
  - "Manual out-of-band kubectl changes applied directly to cluster"
steps:
  - "Inspect drift summary using `node scripts/check-argocd-drift.js` or `argocd app diff stellar-indigopay`."
  - "Identify whether the diff is caused by an uncommitted cluster change or an un-synced Git commit."
  - "If an out-of-band change was made in emergency, export it, commit it to git repo via PR, and merge."
  - "To resync from git source of truth, run `argocd app sync stellar-indigopay`."
  - "CAUTION: Using `--force` sync will overwrite cluster resources. Ensure persistent volume claims or stateful secrets are preserved."
verification:
  - "Verify application status in ArgoCD is Synced and Healthy."
  - "Confirm `argocd_app_info{sync_status='Synced'}`."
rollback:
  - "If git commit caused unexpected drift/failure, revert git commit on main and re-sync."
---

# ArgoCD GitOps Sync Drift & Health Runbook

## Policy Statement: Sync is Source of Truth
All Kubernetes resources for `stellar-indigopay` must be declared in Git (`gitops/` and `helm/indigopay`).
Direct out-of-band modifications via `kubectl apply` or `kubectl edit` are strictly discouraged. In emergency break-glass scenarios where a cluster patch is applied directly:
1. Immediately document the manual patch in an issue.
2. Port the manifest change back into `helm/indigopay` or `gitops/`.
3. Merge via PR so ArgoCD returns to a clean `Synced` state.

## Drift Diagnosis
Run the drift check script:
```bash
node scripts/check-argocd-drift.js
```
Or view the diff via ArgoCD CLI:
```bash
argocd app diff stellar-indigopay
```

## Resync Procedure
```bash
argocd app sync stellar-indigopay
```
> [!CAUTION]
> Do NOT use `argocd app sync --force` unless you have verified that no StatefulSet storage or active secrets will be destructively recreated.
