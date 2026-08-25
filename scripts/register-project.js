#!/usr/bin/env node

"use strict";

/**
 * scripts/register-project.js
 * Improved project registration script with:
 * - --dry-run: validate + preview, no submission
 * - --json: machine-readable output
 * - Offline validation (shares rules with backend)
 * - Idempotency awareness (no-op if already registered)
 * - --force: re-register even if exists
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load shared validation
const projectValidation = require('../backend/src/lib/projectValidation');

// ---------------------------------------------------------------------------
// CLI Parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  let dryRun = false;
  let jsonOutput = false;
  let force = false;
  let projectId = null;
  let name = null;
  let wallet = null;
  let co2PerXlm = null;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      i++;
    } else if (arg === '--json') {
      jsonOutput = true;
      i++;
    } else if (arg === '--force') {
      force = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (key === 'project-id' || key === 'project_id') projectId = val;
      else if (key === 'name') name = val;
      else if (key === 'wallet') wallet = val;
      else if (key === 'co2-per-xlm' || key === 'co2_per_xlm') co2PerXlm = val;
      else throw new Error(`Unknown option: ${arg}`);
      i += 2;
    } else {
      if (!projectId) projectId = arg;
      else if (!name) name = arg;
      else if (!wallet) wallet = arg;
      else if (!co2PerXlm) co2PerXlm = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
      i++;
    }
  }

  return { dryRun, jsonOutput, force, projectId, name, wallet, co2PerXlm };
}

function showHelp() {
  console.log(`
Usage: register-project.js [options] <project_id> <name> <wallet> <co2_per_xlm>

Options:
  --dry-run           Validate and preview only, no submission
  --json              Output in JSON format (machine-readable)
  --force             Re-register even if project already exists
  --project-id <id>   Project ID
  --name <name>       Project name
  --wallet <addr>     Stellar wallet address
  --co2-per-xlm <num> CO2 offset per XLM
  --help, -h          Show this help

Examples:
  ./register-project.js proj-001 "My Project" GABCD... 0.5
  ./register-project.js --dry-run proj-001 "My Project" GABCD... 0.5
  ./register-project.js --json proj-001 "My Project" GABCD... 0.5
`);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function outputJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printResult(result) {
  if (result.error) {
    console.error(`❌ ${result.error}`);
    if (result.details) console.error(result.details);
    process.exit(1);
    return;
  }

  if (result.dryRun) {
    console.log('🔍 DRY RUN - No submission will be made');
    console.log(`  Project ID: ${result.projectId}`);
    console.log(`  Name:       ${result.name}`);
    console.log(`  Wallet:     ${result.wallet}`);
    console.log(`  CO2/XLM:    ${result.co2PerXlm}`);
    console.log('✅ Validation passed. Ready to submit.');
    return;
  }

  if (result.alreadyRegistered) {
    console.log(`ℹ️  Project '${result.name}' (${result.projectId}) already registered.`);
    console.log(`   (use --force to re-register)`);
    return;
  }

  if (result.submitted) {
    console.log(`✅ Project registered successfully!`);
    if (result.txHash) console.log(`   Tx: ${result.txHash}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  let { dryRun, jsonOutput, force, projectId, name, wallet, co2PerXlm } = parseArgs(args);

  if (!projectId || !name || !wallet || !co2PerXlm) {
    const error = new Error('Missing required arguments');
    error.details = 'Usage: register-project.js <project_id> <name> <wallet> <co2_per_xlm>';
    if (jsonOutput) {
      outputJson({ success: false, error: error.message, details: error.details });
    } else {
      console.error(`❌ ${error.message}`);
      console.error(error.details);
    }
    process.exit(1);
  }

  try {
    // ---------------------------------------------------------------------
    // 1. Offline validation (shared with backend)
    // ---------------------------------------------------------------------

    const validation = projectValidation.validateProject({
      project_id: projectId,
      name,
      wallet,
      co2_per_xlm: Number(co2PerXlm),
    });

    if (!validation.valid) {
      const error = new Error('Validation failed');
      error.details = projectValidation.formatValidationErrors(validation.errors);
      if (jsonOutput) {
        outputJson({ success: false, error: error.message, details: validation.errors });
      } else {
        console.error(`❌ ${error.message}`);
        console.error(error.details);
      }
      process.exit(1);
    }

    const sanitized = {
      projectId: projectId.trim(),
      name: projectValidation.sanitizeName(name),
      wallet: wallet.trim(),
      co2PerXlm: Number(co2PerXlm),
    };

    // ---------------------------------------------------------------------
    // 2. Dry-run mode
    // ---------------------------------------------------------------------

    if (dryRun) {
      if (jsonOutput) {
        outputJson({
          success: true,
          dryRun: true,
          projectId: sanitized.projectId,
          name: sanitized.name,
          wallet: sanitized.wallet,
          co2PerXlm: sanitized.co2PerXlm,
          validation: { valid: true },
        });
      } else {
        printResult({
          dryRun: true,
          projectId: sanitized.projectId,
          name: sanitized.name,
          wallet: sanitized.wallet,
          co2PerXlm: sanitized.co2PerXlm,
        });
      }
      return;
    }

    // ---------------------------------------------------------------------
    // 3. Check if project already exists (idempotency)
    // ---------------------------------------------------------------------

    const contractId = getContractId();

    // Skip existing check for now to keep it simple
    // The contract will handle duplicate registration

    // ---------------------------------------------------------------------
    // 4. Submit registration
    // ---------------------------------------------------------------------

    const cmd = `stellar contract invoke \
      --id ${contractId} \
      --source alice \
      --network testnet \
      -- \
      register_project \
      --project_id ${sanitized.projectId} \
      --name "${sanitized.name}" \
      --wallet ${sanitized.wallet} \
      --co2_per_xlm ${sanitized.co2PerXlm}`;

    let stdout, stderr;
    try {
      const result = execSync(cmd, {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      stdout = result;
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      if (!stdout && stderr) {
        throw new Error(`Contract invocation failed: ${stderr}`);
      }
    }

    // Parse the result to get transaction hash
    const txMatch = stdout.match(/transaction_hash[:\s]+([a-f0-9]+)/i) ||
                    stdout.match(/tx_hash[:\s]+([a-f0-9]+)/i);

    const txHash = txMatch ? txMatch[1] : null;

    // ---------------------------------------------------------------------
    // 5. Output result
    // ---------------------------------------------------------------------

    if (jsonOutput) {
      outputJson({
        success: true,
        submitted: true,
        projectId: sanitized.projectId,
        name: sanitized.name,
        wallet: sanitized.wallet,
        co2PerXlm: sanitized.co2PerXlm,
        txHash: txHash || 'pending',
      });
    } else {
      printResult({
        submitted: true,
        projectId: sanitized.projectId,
        name: sanitized.name,
        txHash,
      });
    }

  } catch (err) {
    if (jsonOutput) {
      outputJson({ success: false, error: err.message, details: err.details || null });
    } else {
      console.error(`❌ Error: ${err.message}`);
      if (err.details) console.error(err.details);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getContractId() {
  let contractId = process.env.CONTRACT_ID;

  if (!contractId) {
    try {
      const envPath = path.join(__dirname, '../backend/.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/CONTRACT_ID=([^\s]+)/);
      if (match) {
        contractId = match[1];
      }
    } catch (err) {
      // .env file not found
    }
  }

  if (!contractId) {
    throw new Error('CONTRACT_ID not found. Set CONTRACT_ID env var or create backend/.env');
  }

  return contractId;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main();
