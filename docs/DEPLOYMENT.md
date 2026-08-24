# Deployment Guide

This document covers the full production deployment process for Stellar-IndigoPay using Kubernetes and Helm.

## Prerequisites

Before deploying to production, ensure you have the following installed and configured:

- **`kubectl`**: The Kubernetes command-line tool.
- **`helm`**: The Helm package manager (v3+).
- **A Kubernetes Cluster**: Running on a cloud provider like GCP (GKE), AWS (EKS), or a managed cluster.
- **Cloud Provider CLI**: (e.g., `gcloud` for GCP, `aws` for AWS) configured with appropriate access rights.

## Creating secrets from .env

The application requires various environment variables (e.g., database credentials, API keys) to function securely. These must be stored as Kubernetes Secrets rather than in the Helm chart directly.

Create a Kubernetes Secret from your `.env` file:

```bash
kubectl create secret generic stellar-indigopay-secrets --from-env-file=.env
```

_Note: Ensure your `.env` file is properly configured for the production environment and NEVER committed to version control._

## Deploying with Helm

Once your secrets are in place, you can deploy the application using the provided Helm chart.

Run the following command from the root of the repository:

```bash
helm install stellar-indigopay helm/indigopay/
```

This will deploy the required deployments, services, and other resources as defined in the Helm chart.

## Configuring Ingress and TLS

To expose the application securely over HTTPS, configure an Ingress resource with TLS.

1.  **Ingress Controller**: Ensure an Ingress controller (e.g., NGINX) is running in your cluster.
2.  **Cert-Manager**: Install `cert-manager` to automatically provision and manage TLS certificates (e.g., via Let's Encrypt).
3.  **Update `values.yaml`**: Update the `helm/indigopay/values.yaml` (or pass a custom `values-prod.yaml`) to enable the Ingress and configure TLS hosts.

Example configuration snippet:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: api.stellarindigopay.example.com
      paths:
        - path: /
          pathType: ImplementationSpecific
  tls:
    - secretName: stellar-indigopay-tls
      hosts:
        - api.indigopay.example.com
```

Apply the updated configuration:

```bash
helm upgrade stellar-indigopay helm/indigopay/ -f values-prod.yaml
```

## Running database migrations post-deploy

After the application is deployed, you must run the database migrations to set up the production schema.

Connect to a running backend pod or execute a one-off job to run the migration script:

```bash
kubectl exec -it deployment/stellar-indigopay-backend -- npm run migrate
```

_(Adjust the command if you use a dedicated migration job or a different package manager command.)_

## Registering the Soroban contract on mainnet

After deploying the infrastructure, you must deploy and register the Soroban smart contract on the Stellar mainnet.

1.  **Compile the Contract**: Ensure your contract is compiled to a WebAssembly (.wasm) file and optimized for deployment.
2.  **Deploy to Mainnet**: Use the Stellar CLI to deploy the contract.

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/indigopay_contract.wasm \
  --source admin \
  --network mainnet
```

Once deployed, update your application configuration (via Secrets or ConfigMaps) with the new mainnet Contract ID.

## Horizontal Pod Autoscaling (HPA) & Custom Metrics

The backend deployment scales dynamically using Kubernetes HorizontalPodAutoscaler (`k8s/hpa-backend.yaml` or Helm `autoscaling`).

### Metric Triggers

The backend is queue-driven and relies on custom workload metrics as primary scaling signals, backed up by resource metrics as fallbacks:

1. **`queue_depth`** (`External`, target average: `20`): Total pg-boss jobs active or waiting (`webhook-deliveries`, `ai-summary`, `profile-update`, `monthly-impact-digest`).
2. **`indexer_lag_seconds`** (`External`, target value: `10s`): Cluster-wide seconds between the latest ledger seen by the Soroban/Horizon indexer and current time.
3. **`cpu`** (`Resource`, target average utilization: `70%`): Fallback CPU utilization.
4. **`memory`** (`Resource`, target average utilization: `80%`): Fallback memory utilization.

### Setting up `k8s-prometheus-adapter`

Custom metrics are exported by the backend at `/metrics` and scraped by Prometheus. To expose them to Kubernetes HPA, install `k8s-prometheus-adapter` and apply the rule configuration:

```bash
# 1. Apply the Prometheus adapter ConfigMap containing the rules
kubectl apply -f k8s/prometheus-adapter-configmap.yaml

# 2. Install k8s-prometheus-adapter via Helm
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace stellar-indigopay \
  --set rules.existing=prometheus-adapter-config
```

The application chart also exposes `rules.existing: prometheus-adapter-config` in `helm/indigopay/values.yaml` for installations that share the values file with the adapter chart.

If custom metrics are unavailable, the HPA reports metric retrieval errors but can still calculate desired replicas from the available CPU and memory metrics.
