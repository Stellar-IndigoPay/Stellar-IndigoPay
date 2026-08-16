const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const GITLEAKS_TOML = path.join(process.cwd(), ".gitleaks.toml");
const GITLEAKS_TEMP = path.join(process.cwd(), ".gitleaks.temp.toml");
const REPORT_PATH = path.join(process.cwd(), "gitleaks-raw.json");

function extractAllowlist(content) {
  // A simple regex approach to extract paths and regexes
  const allowlistMatch = content.match(/\[allowlist\]([\s\S]*?)(?:\[\w+\]|$)/);
  const paths = [];
  const regexes = [];
  
  if (allowlistMatch) {
    const allowlistBlock = allowlistMatch[1];
    
    // Extract paths array
    const pathsMatch = allowlistBlock.match(/paths\s*=\s*\[([\s\S]*?)\]/);
    if (pathsMatch) {
      const p = pathsMatch[1].match(/"([^"]+)"|'([^']+)'/g);
      if (p) p.forEach(x => paths.push(x.replace(/['"]/g, '')));
    }
    
    // Extract regexes array
    const regexesMatch = allowlistBlock.match(/regexes\s*=\s*\[([\s\S]*?)\]/);
    if (regexesMatch) {
      const r = regexesMatch[1].match(/'''(.*?)'''|"""(.*?)"""|'([^']+)'|"([^"]+)"/g);
      if (r) r.forEach(x => regexes.push(x.replace(/'''|"""|['"]/g, '')));
    }
  }
  
  const contentWithoutAllowlist = content.replace(/\[allowlist\][\s\S]*?(?:(?=\[\w+\])|$)/, '');
  return { paths, regexes, contentWithoutAllowlist };
}

function runCheck() {
  console.log("=== Gitleaks Staleness Check ===");
  if (!fs.existsSync(GITLEAKS_TOML)) {
    console.log("No .gitleaks.toml found, skipping.");
    process.exit(0);
  }

  const content = fs.readFileSync(GITLEAKS_TOML, 'utf8');
  const { paths, regexes, contentWithoutAllowlist } = extractAllowlist(content);

  if (paths.length === 0 && regexes.length === 0) {
    console.log("No allowlist entries found in .gitleaks.toml, skipping check.");
    process.exit(0);
  }

  fs.writeFileSync(GITLEAKS_TEMP, contentWithoutAllowlist);
  
  try {
    console.log("Running raw gitleaks scan...");
    execSync(`gitleaks detect --config ${GITLEAKS_TEMP} --source . --no-git --report-format json --report-path ${REPORT_PATH} --exit-code 0`, { stdio: 'ignore' });
  } catch (err) {
    console.error("Failed to run gitleaks:", err.message);
  } finally {
    if (fs.existsSync(GITLEAKS_TEMP)) {
      fs.unlinkSync(GITLEAKS_TEMP);
    }
  }

  let report = [];
  if (fs.existsSync(REPORT_PATH)) {
    try {
      report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    } catch(e) {}
    fs.unlinkSync(REPORT_PATH);
  }

  const usedPaths = new Set();
  const usedRegexes = new Set();

  for (const finding of report) {
    // Check paths
    paths.forEach((p, idx) => {
      try {
        if (new RegExp(p).test(finding.File)) usedPaths.add(idx);
      } catch (e) {}
    });
    
    // Check regexes against Match string
    regexes.forEach((r, idx) => {
      try {
        if (new RegExp(r, 'i').test(finding.Match)) usedRegexes.add(idx);
      } catch (e) {}
    });
  }

  const stalePaths = paths.filter((_, idx) => !usedPaths.has(idx));
  const staleRegexes = regexes.filter((_, idx) => !usedRegexes.has(idx));

  if (stalePaths.length > 0 || staleRegexes.length > 0) {
    console.error(`\n🔴 FAILED CI: Detected stale Gitleaks suppressions in .gitleaks.toml!`);
    
    if (stalePaths.length > 0) {
      console.error("\nStale allowlist paths:");
      stalePaths.forEach(p => console.error(`  - ${p}`));
    }
    
    if (staleRegexes.length > 0) {
      console.error("\nStale allowlist regexes:");
      staleRegexes.forEach(r => console.error(`  - ${r}`));
    }
    
    console.error("\nTo resolve this: Remove the stale entries from .gitleaks.toml [allowlist] since they no longer match any active findings.");
    process.exit(1);
  }

  console.log("\n✅ CI SUCCESS: No stale Gitleaks suppressions found.");
  process.exit(0);
}

runCheck();
