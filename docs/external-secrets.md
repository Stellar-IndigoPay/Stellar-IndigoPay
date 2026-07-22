# External Secrets Manager

This repo can hydrate Kubernetes `Secret` resources from an external
secrets manager instead of committing a `k8s/secret.yaml` to git.
The `external-secrets-operator` watches `ExternalSecret` resources and
syncs values from AWS Secrets Manager, GCP Secret Manager, HashiCorp
Vault, or Azure Key Vault into cluster Secrets on a configurable
interval (default 1h, configurable in `k8s/external-secret.yaml`).

## Why

A committed `k8s/secret.yaml` with placeholder passwords is a footgun:
even with CI lint, someone will eventually apply the default. Pulling
secrets from a central store gives us:

- **Single source of truth** — one place to rotate, audit, and revoke.
- **Rotation without redeploy** — the operator refreshes the K8s
  Secret on a schedule; pods pick it up via `envFrom: secretRef:`.
- **Audit trail** — every read of the secret is logged in the manager
  (CloudTrail, Audit Logs, etc.).
- **Cross-cluster consistency** — every environment pulls from the
  same logical store.

## Setup

1. Install the operator:

   ```bash
   helm repo add external-secrets https://charts.external-secrets.io
   helm install external-secrets external-secrets/external-secrets \
     --namespace external-secrets --create-namespace
   ```

2. Create the secrets in your manager of choice. The expected layout
   is one secret per environment (e.g. `stellar-indigopay/prod`) with JSON
   keys for each value:

   ```json
   {
     "postgres_user": "indigopay",
     "postgres_password": "...",
     "postgres_db": "indigopay",
     "database_url": "postgres://...",
     "resend_api_key": "...",
     "admin_api_key": "...",
     "metrics_bearer_token": "...",
     "anthropic_api_key": "...",
     "jwt_secret": "...",
     "webhook_signing_secret": "...",
     "recurring_signer_secret": "..."
   }
   ```

3. Configure IAM access for the operator:
   - **AWS**: create an IAM role with `secretsmanager:GetSecretValue`
     on `arn:aws:secretsmanager:*:*:secret:stellar-indigopay/*`. Bind via
     IRSA (EKS) or kube2iam.
   - **GCP**: grant `secretmanager.secretAccessor` on the secret to
     the operator's GCP service account via Workload Identity.
   - **Vault**: configure an AppRole or Kubernetes auth method.

4. Apply the manifest:

   ```bash
   kubectl apply -f k8s/external-secret.yaml
   ```

5. Verify:
   ```bash
   kubectl get externalsecret -n stellar-indigopay
   # NAME                 STORE                  REFRESH   STATUS
   # stellar-indigopay-secrets    aws-secrets-manager    58m       SecretSynced
   ```

## When NOT to use

For local dev and CI test runs, the regular `k8s/secret.yaml` (or
`docker-compose.yml` env vars) is fine. The external-secrets pattern
is for prod-grade clusters.

## Switching providers

`k8s/external-secret.yaml` ships with an AWS Secrets Manager
SecretStore. To switch providers, replace the `provider` block with
the equivalent for your store (GCP, Vault, etc.). The
`ExternalSecret.data` mapping is provider-agnostic.

## Automated Secret Rotation

Stellar-IndigoPay rotates secrets automatically on a **quarterly
schedule** with zero-downtime rollout and automatic rollback on
health check failure.

### Rotation Scope

The following secrets are rotated every quarter:

| Secret                     | Format                                      |
| -------------------------- | ------------------------------------------- |
| `DATABASE_URL`             | PostgreSQL connection string (password rotated) |
| `JWT_SECRET`               | 64-char base64 random                       |
| `WEBHOOK_SIGNING_SECRET`   | 64-char hex random                          |
| `ADMIN_API_KEY`            | `ip_admin_` + 48-char hex                   |
| `RECURRING_SIGNER_SECRET`  | 44-char base64 random                       |

### Rotation Workflow

The rotation is implemented as a GitHub Actions workflow at
`.github/workflows/secret-rotation.yml`.

**Schedule:** Every quarter — Jan 1, Apr 1, Jul 1, Oct 1 at 02:00 UTC.

**Manual trigger:** Use `workflow_dispatch` from the Actions tab with
optional inputs:
- `secrets_to_rotate`: comma-separated list (defaults to all five)
- `skip_health_check`: boolean (use with caution)
- `skip_rollback`: boolean (debugging use only)

**Workflow phases:**

1. **Pre-rotation validation** — verifies that every target secret
   exists in AWS Secrets Manager. Stores old values for potential
   rollback.

2. **Generate new values** — produces cryptographically random
   replacements using `openssl rand`. Each secret type uses an
   appropriate format (base64, hex, or structured).

3. **Update secrets manager** — writes the new values to AWS Secrets
   Manager at `stellar-indigopay/prod`.

4. **Trigger ESO force-sync** — annotates the `ExternalSecret`
   resource with `force-sync=<timestamp>` to trigger an immediate
   refresh (bypassing the default 1h refresh interval).

5. **Rolling restart** — runs `kubectl rollout restart deployment/backend`
   with a 5-minute timeout on the rollout status.

6. **Health validation** — polls `/health/ready` (HTTP 200) every 10
   seconds for up to 5 minutes. This endpoint validates every external
   dependency: Postgres, Redis (if configured), Horizon, Soroban RPC,
   and the indexer.

7. **Auto-rollback** — if the health check fails, the workflow
   automatically restores the previous secret values in AWS Secrets
   Manager, triggers another ESO force-sync, and restarts the backend
   to pick up the old values.

8. **Audit logging** — records the rotation outcome (including
   secrets rotated, timestamps, health check result, and rollback
   status) to the `secret_rotations` database table via the admin API
   at `POST /api/admin/secret-rotations`.

### Monitoring

Three Prometheus alerts are defined in `monitoring/alert-rules.yml`:

| Alert                    | Severity | Description                                           |
| ------------------------ | -------- | ----------------------------------------------------- |
| `SecretRotationFailed`   | page     | Rotation failed or rolled back in the last hour       |
| `SecretRotationStuck`    | warn     | Rotation stuck `in_progress` for more than 30 minutes |
| `SecretRotationOverdue`  | warn     | No successful rotation in more than 95 days           |

### Viewing Rotation History

Administrators can view the rotation audit trail at:

```
GET /api/admin/secret-rotations        — list all rotations
GET /api/admin/secret-rotations/:id     — view a single rotation
GET /api/admin/secret-rotations/latest/status — quick status
```

All endpoints require admin authentication via bearer token.
