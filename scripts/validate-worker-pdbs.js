const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const k8sDir = path.join(__dirname, '../k8s');

function validateWorkerPDBs() {
  const files = fs.readdirSync(k8sDir).filter(f => f.endsWith('.yaml'));
  const deployments = [];
  const pdbs = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(k8sDir, file), 'utf8');
    const docs = yaml.loadAll(content);
    for (const doc of docs) {
      if (!doc) continue;
      if (doc.kind === 'Deployment' && doc.metadata?.name?.includes('worker')) {
        deployments.push(doc);
      }
      if (doc.kind === 'PodDisruptionBudget') {
        pdbs.push(doc);
      }
    }
  }

  let hasError = false;

  for (const dep of deployments) {
    const name = dep.metadata.name;
    const isExclusive = name.includes('indexer') || name.includes('keeper') || name.includes('guardian');
    const isScaled = name.includes('webhook') || name.includes('digest') || name.includes('outbox');

    // Check PDB
    const pdb = pdbs.find(p => p.spec?.selector?.matchLabels?.app === dep.spec?.selector?.matchLabels?.app);
    if (!pdb) {
      console.error(`[Error] Worker Deployment '${name}' has no matching PodDisruptionBudget.`);
      hasError = true;
      continue;
    }

    if (isExclusive) {
      if (pdb.spec.minAvailable !== 1) {
        console.error(`[Error] Exclusive worker '${name}' PDB must have minAvailable: 1.`);
        hasError = true;
      }
    } else if (isScaled) {
      if (pdb.spec.maxUnavailable !== 1 && pdb.spec.maxUnavailable !== '25%') {
        console.error(`[Error] Scaled worker '${name}' PDB must have maxUnavailable: 1 or 25%.`);
        hasError = true;
      }
    }

    // Check probes and preStop
    const container = dep.spec.template.spec.containers[0];
    if (!container.startupProbe || !container.readinessProbe) {
      console.error(`[Error] Worker '${name}' is missing startupProbe or readinessProbe.`);
      hasError = true;
    }
    
    if (!container.lifecycle?.preStop) {
      console.error(`[Error] Worker '${name}' is missing preStop hook for graceful drain.`);
      hasError = true;
    }
  }

  if (hasError) {
    process.exit(1);
  } else {
    console.log('Worker PDB and probe validation passed.');
  }
}

validateWorkerPDBs();
