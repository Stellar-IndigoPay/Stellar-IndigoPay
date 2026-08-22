const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const SCRIPTS_DIR = __dirname;
const CWD = process.cwd();

// Helpers for temp files
const writeJson = (name, data) => fs.writeFileSync(path.join(CWD, name), JSON.stringify(data));
const writeText = (name, text) => fs.writeFileSync(path.join(CWD, name), text);
const cleanup = (files) => {
  files.forEach(f => {
    try { fs.unlinkSync(path.join(CWD, f)) } catch(e) {}
  });
};

test('Staleness Checks Test Suite', async (t) => {
  
  await t.test('ZAP staleness check', async (t) => {
    const reportFile = 'report.json';
    const configFile = 'zap-false-positives.json';
    
    // Test 1: Stale ignore fails
    writeJson(reportFile, {
      site: [{
        alerts: [{
          riskcode: "3",
          pluginid: "10020",
          alert: "X-Frame-Options Header Scanner",
          instances: [{ uri: "https://staging.indigopay.app/widget" }]
        }]
      }]
    });
    
    writeJson(configFile, {
      ignored_alerts: [
        { pluginId: "10020" }, // This one is active
        { pluginId: "99999", url: "stale-url" } // This one is stale
      ]
    });
    
    assert.throws(() => {
      execSync(`node ${path.join(SCRIPTS_DIR, 'triage-zap.js')}`, { stdio: 'pipe' });
    }, /FAILED CI: Detected 1 stale ZAP suppressions/);

    // Test 2: Active ignore passes
    writeJson(configFile, {
      ignored_alerts: [
        { pluginId: "10020" }
      ]
    });
    
    execSync(`node ${path.join(SCRIPTS_DIR, 'triage-zap.js')}`, { stdio: 'pipe' }); // should not throw
    
    cleanup([reportFile, configFile]);
  });

  await t.test('Trivy staleness check', async (t) => {
    const ignoreFile = '.trivyignore';
    const reportFile = 'trivy-raw-test.json';
    
    // Stale test
    writeText(ignoreFile, "CVE-2024-1111\nCVE-2024-2222"); // 2222 is stale
    
    writeJson(reportFile, {
      Results: [{
        Vulnerabilities: [{ VulnerabilityID: "CVE-2024-1111" }]
      }]
    });
    
    assert.throws(() => {
      execSync(`node ${path.join(SCRIPTS_DIR, 'check-stale-trivy.js')}`, { stdio: 'pipe' });
    }, /FAILED CI: Detected stale Trivy suppressions/);

    // Active test
    writeText(ignoreFile, "CVE-2024-1111");
    execSync(`node ${path.join(SCRIPTS_DIR, 'check-stale-trivy.js')}`, { stdio: 'pipe' });
    
    cleanup([ignoreFile, reportFile]);
  });

  await t.test('Gitleaks staleness check', async (t) => {
    // Note: We test the logic indirectly by providing a raw report manually, 
    // since gitleaks binary might not be available in test environment, 
    // the script handles failure to run gracefully but still processes the report if it exists.
    const ignoreFile = '.gitleaks.toml';
    const rawReportFile = 'gitleaks-raw.json';
    
    writeText(ignoreFile, `
[allowlist]
paths = [
  "\\\\.test\\\\.js$",
  "stale-path"
]
regexes = [
  '''(?i)(changeme)''',
  '''(?i)(stale-regex)'''
]
`);
    
    writeJson(rawReportFile, [
      { File: "src/app.test.js", Match: "changeme" } // Satisfies test.js and changeme
    ]);
    
    assert.throws(() => {
      execSync(`node ${path.join(SCRIPTS_DIR, 'check-stale-gitleaks.js')}`, { stdio: 'pipe' });
    }, /FAILED CI: Detected stale Gitleaks suppressions/);
    
    // Active test
    writeText(ignoreFile, `
[allowlist]
paths = [
  "\\\\.test\\\\.js$"
]
regexes = [
  '''(?i)(changeme)'''
]
`);
    
    writeJson(rawReportFile, [
      { File: "src/app.test.js", Match: "changeme" } 
    ]);
    
    execSync(`node ${path.join(SCRIPTS_DIR, 'check-stale-gitleaks.js')}`, { stdio: 'pipe' });

    cleanup([ignoreFile, rawReportFile, '.gitleaks.temp.toml']);
  });

});
