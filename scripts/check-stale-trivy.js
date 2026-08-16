const fs = require("fs");
const path = require("path");

const TRIVY_IGNORE = path.join(process.cwd(), ".trivyignore");

function runCheck() {
  console.log("=== Trivy Staleness Check ===");
  if (!fs.existsSync(TRIVY_IGNORE)) {
    console.log("No .trivyignore found, skipping.");
    process.exit(0);
  }

  const ignoreContent = fs.readFileSync(TRIVY_IGNORE, 'utf8');
  const ignoredCves = ignoreContent.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  if (ignoredCves.length === 0) {
    console.log("No CVEs in .trivyignore, skipping check.");
    process.exit(0);
  }

  // Find all trivy-raw-*.json files in the current directory
  const files = fs.readdirSync(process.cwd());
  const reportFiles = files.filter(f => f.startsWith("trivy-raw-") && f.endsWith(".json"));

  if (reportFiles.length === 0) {
    console.log("No raw Trivy reports (trivy-raw-*.json) found to check against. Skipping.");
    process.exit(0);
  }

  const allVulnerabilities = new Set();

  for (const reportFile of reportFiles) {
    try {
      const reportPath = path.join(process.cwd(), reportFile);
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      
      const results = data.Results || [];
      for (const result of results) {
        const vulns = result.Vulnerabilities || [];
        for (const vuln of vulns) {
          allVulnerabilities.add(vuln.VulnerabilityID);
        }
      }
    } catch (err) {
      console.error(`Failed to parse ${reportFile}:`, err.message);
    }
  }

  const staleCves = ignoredCves.filter(cve => !allVulnerabilities.has(cve));

  if (staleCves.length > 0) {
    console.error(`\n🔴 FAILED CI: Detected stale Trivy suppressions in .trivyignore!`);
    console.error("\nThe following CVEs were ignored but are no longer present in any raw Trivy scan:");
    staleCves.forEach(cve => console.error(`  - ${cve}`));
    
    console.error("\nTo resolve this: Remove the stale entries from .trivyignore since they no longer match any active findings.");
    process.exit(1);
  }

  console.log("\n✅ CI SUCCESS: No stale Trivy suppressions found.");
  process.exit(0);
}

runCheck();
