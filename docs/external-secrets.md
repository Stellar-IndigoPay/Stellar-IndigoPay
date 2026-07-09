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
   is one secret per environment (e.g. `indigopay/prod`) with JSON
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
     "jwt_secret": "..."
   }
   ```

3. Configure IAM access for the operator:
   - **AWS**: create an IAM role with `secretsmanager:GetSecretValue`
     on `arn:aws:secretsmanager:*:*:secret:indigopay/*`. Bind via
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
   kubectl get externalsecret -n indigopay
   # NAME                 STORE                  REFRESH   STATUS
   # indigopay-secrets    aws-secrets-manager    58m       SecretSynced
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
