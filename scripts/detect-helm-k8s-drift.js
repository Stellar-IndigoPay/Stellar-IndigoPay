const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(__dirname, "..");

// Resources that are documented, intentional gaps between the Helm chart
// and the raw k8s manifests. Anything only-in-k8s that is NOT in this list
// is treated as undocumented drift and fails CI.
const ALLOWED_ONLY_IN_K8S = [
  "NetworkPolicy/default-deny-all",
  "NetworkPolicy/allow-backend-to-postgres",
  "NetworkPolicy/allow-backend-to-redis",
  "NetworkPolicy/allow-frontend-to-backend",
  "NetworkPolicy/allow-ingress-controller-to-backend",
  "NetworkPolicy/allow-backend-egress-external",
  "NetworkPolicy/allow-primary-from-standby",
  "NetworkPolicy/allow-standby-to-primary",
  "NetworkPolicy/allow-exporter-to-postgres",
  "NetworkPolicy/allow-prometheus-scrape-backend",
  "Deployment/postgres-exporter-primary",
  "Deployment/postgres-exporter-standby",
  "Service/postgres-exporter-primary",
  "Service/postgres-exporter-standby"
];

const PARITY_FLAGS = [
  "postgres.standby.enabled=true",
  "postgres.failover.enabled=true",
  "postgres.replication.enabled=true",
  "postgres.replication.walArchive.enabled=true",
  "postgres.replication.walArchive.s3Bucket=stellar-indigopay-backups",
  "backend.serviceMonitor.enabled=true"
];

function loadAllDocs(raw) {
  return yaml.loadAll(raw).filter((d) => d && typeof d === "object");
}

function keyOf(doc) {
  return doc.kind + "/" + (doc.metadata && doc.metadata.name);
}

function renderHelm() {
  const setArgs = PARITY_FLAGS.map((f) => "--set " + f).join(" ");
  const chartPath = path.join(REPO_ROOT, "helm", "indigopay");
  const cmd = "helm template indigopay " + chartPath + " " + setArgs;
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const docs = loadAllDocs(raw);
  const map = new Map();
  for (const d of docs) map.set(keyOf(d), d);
  return map;
}

function readK8sManifests() {
  const k8sDir = path.join(REPO_ROOT, "k8s");
  const kustom = yaml.load(fs.readFileSync(path.join(k8sDir, "kustomization.yaml"), "utf8"));
  const map = new Map();
  for (const rel of kustom.resources) {
    const raw = fs.readFileSync(path.join(k8sDir, rel), "utf8");
    const docs = loadAllDocs(raw);
    for (const d of docs) map.set(keyOf(d), d);
  }
  return map;
}

// Curated drift-sensitive fields per kind. metadata.labels is deliberately
// excluded everywhere: helm/indigopay/templates/hpa.yaml and pdb.yaml pull
// extra labels from the stellar-indigopay.labels helper that the raw
// k8s/hpa-backend.yaml / k8s/pdb-backend.yaml manifests don't carry, which
// would otherwise false-positive on an unrelated, already-known inconsistency.
function driftFields(doc) {
  switch (doc.kind) {
    case "Deployment":
    case "StatefulSet": {
      const podSpec = (doc.spec && doc.spec.template && doc.spec.template.spec) || {};
      const containers = (podSpec.containers || [])
        .map((c) => ({
          name: c.name,
          image: c.image,
          ports: (c.ports || [])
            .map((p) => ({ containerPort: p.containerPort, protocol: p.protocol || "TCP" }))
            .sort((a, b) => a.containerPort - b.containerPort),
          resources: c.resources || {},
          envFrom: (c.envFrom || [])
            .map((e) => (e.configMapRef && e.configMapRef.name) || (e.secretRef && e.secretRef.name))
            .filter(Boolean)
            .sort()
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        replicas: doc.spec.replicas,
        terminationGracePeriodSeconds: podSpec.terminationGracePeriodSeconds,
        containers
      };
    }
    case "Service":
      return {
        ports: (doc.spec.ports || [])
          .map((p) => ({ port: p.port, targetPort: p.targetPort, protocol: p.protocol || "TCP", name: p.name }))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      };
    case "ConfigMap":
    case "Secret":
      return { keys: Object.keys(doc.data || {}).sort() };
    case "Ingress":
      return {
        rules: (doc.spec.rules || [])
          .map((r) => ({
            host: r.host,
            paths: ((r.http && r.http.paths) || [])
              .map((p) => ({
                path: p.path,
                service: (p.backend && p.backend.service && p.backend.service.name) || (p.backend && p.backend.serviceName)
              }))
              .sort((a, b) => (a.path || "").localeCompare(b.path || ""))
          }))
          .sort((a, b) => (a.host || "").localeCompare(b.host || ""))
      };
    case "HorizontalPodAutoscaler":
      return { minReplicas: doc.spec.minReplicas, maxReplicas: doc.spec.maxReplicas, metrics: doc.spec.metrics };
    case "PodDisruptionBudget":
      return { minAvailable: doc.spec.minAvailable };
    default:
      return null;
  }
}

function main() {
  const helmMap = renderHelm();
  const k8sMap = readK8sManifests();

  const helmKeys = new Set(helmMap.keys());
  const k8sKeys = new Set(k8sMap.keys());
  const allowedSet = new Set(ALLOWED_ONLY_IN_K8S);

  const onlyHelm = [...helmKeys].filter((k) => !k8sKeys.has(k)).sort();
  const onlyK8sAll = [...k8sKeys].filter((k) => !helmKeys.has(k)).sort();
  const onlyK8sUndocumented = onlyK8sAll.filter((k) => !allowedSet.has(k));
  const onlyK8sDocumented = onlyK8sAll.filter((k) => allowedSet.has(k));
  const staleAllowlistEntries = ALLOWED_ONLY_IN_K8S.filter((k) => !onlyK8sAll.includes(k));

  const both = [...helmKeys].filter((k) => k8sKeys.has(k)).sort();
  const fieldDrift = [];

  for (const key of both) {
    const helmFields = driftFields(helmMap.get(key));
    const k8sFields = driftFields(k8sMap.get(key));
    if (helmFields === null || k8sFields === null) continue; // kind not covered, skip
    const helmJson = JSON.stringify(helmFields);
    const k8sJson = JSON.stringify(k8sFields);
    if (helmJson !== k8sJson) {
      fieldDrift.push({ key, helm: helmFields, k8s: k8sFields });
    }
  }

  console.log("=== ONLY IN HELM (undocumented, always fails) ===");
  onlyHelm.forEach((k) => console.log("  " + k));

  console.log("\n=== ONLY IN K8S: undocumented (fails) ===");
  onlyK8sUndocumented.forEach((k) => console.log("  " + k));

  console.log("\n=== ONLY IN K8S: documented/allowed ===");
  onlyK8sDocumented.forEach((k) => console.log("  " + k));

  if (staleAllowlistEntries.length > 0) {
    console.log("\n=== WARNING: stale allowlist entries (no longer only-in-k8s) ===");
    staleAllowlistEntries.forEach((k) => console.log("  " + k));
  }

  console.log("\n=== FIELD DRIFT ON SHARED RESOURCES (" + fieldDrift.length + ") ===");
  for (const d of fieldDrift) {
    console.log("  " + d.key);
    console.log("    helm: " + JSON.stringify(d.helm));
    console.log("    k8s:  " + JSON.stringify(d.k8s));
  }

  const failed = onlyHelm.length > 0 || onlyK8sUndocumented.length > 0 || fieldDrift.length > 0;

  console.log(
    "\nSummary: helm=" + helmMap.size +
    " k8s=" + k8sMap.size +
    " onlyHelm=" + onlyHelm.length +
    " onlyK8sUndocumented=" + onlyK8sUndocumented.length +
    " onlyK8sDocumented=" + onlyK8sDocumented.length +
    " fieldDrift=" + fieldDrift.length
  );

  if (failed) {
    console.log("\nDRIFT CHECK FAILED");
    process.exitCode = 1;
  } else {
    console.log("\nDRIFT CHECK PASSED");
    process.exitCode = 0;
  }
}

if (require.main === module) {
  main();
}

module.exports = { renderHelm, readK8sManifests, driftFields, keyOf, ALLOWED_ONLY_IN_K8S };
