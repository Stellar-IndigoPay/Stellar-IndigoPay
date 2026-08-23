const { server: stellarServer, NETWORK_PASSPHRASE, submitTransaction } = require("./stellar");
const { Contract, nativeToScVal, Keypair, TransactionBuilder } = require("@stellar/stellar-sdk");
const logger = require("../logger");
const { Counter } = require("prom-client");
const { registry } = require("./metrics");
const { getSigningSecret } = require("./signingSecretProvider");
const { withAdvisoryLock, LOCK_KEYS } = require("./advisoryLock");

// 12-hour cadence
const GUARDIAN_INTERVAL_MS = 12 * 60 * 60 * 1000;
// threshold_ledgers = 120,960 * 4 (matching the contract's internal constant)
const THRESHOLD_LEDGERS = 120960 * 4;

let intervalId = null;

const guardianUpdateCounter = new Counter({
  name: "indigopay_guardian_updates_total",
  help: "Guardian TTL update count",
  registers: [registry],
});

async function buildExtendAllTtlTransaction() {
  const contractId = process.env.CONTRACT_ID;
  const adminSecret = await getSigningSecret("oracleAdmin");

  if (!contractId) {
    throw new Error("CONTRACT_ID not configured");
  }
  const keypair = Keypair.fromSecret(adminSecret);
  const adminPublicKey = keypair.publicKey();

  const account = await stellarServer.loadAccount(adminPublicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "extend_all_ttl",
        nativeToScVal(THRESHOLD_LEDGERS, { type: "u32" })
      )
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

async function runGuardian() {
  try {
    const txXdr = await buildExtendAllTtlTransaction();
    await submitTransaction(txXdr);
    guardianUpdateCounter.inc();
    logger.info({ event: "guardian_ttl_extended" }, "Guardian successfully extended all TTLs");
  } catch (err) {
    logger.error({ event: "guardian_ttl_extend_failed", err: err.message }, "Guardian failed to extend TTL");
    throw err;
  }
}

/**
 * Guardian cycle guarded by a per-worker Postgres advisory lock so only one
 * replica extends TTLs at a time (issue #677).
 */
async function runGuardianCycle() {
  return withAdvisoryLock(LOCK_KEYS.guardian, runGuardian);
}

function start() {
  if (intervalId) return;
  
  // Run on startup
  runGuardianCycle().catch((err) => {
    logger.error({ event: "guardian_startup_failed", err: err.message }, "Initial guardian run failed");
  });

  intervalId = setInterval(async () => {
    try {
      await runGuardianCycle();
    } catch (err) {
      // Logged in runGuardian
    }
  }, GUARDIAN_INTERVAL_MS);

  if (typeof intervalId.unref === "function") {
    intervalId.unref();
  }
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = {
  buildExtendAllTtlTransaction,
  runGuardian,
  runGuardianCycle,
  start,
  stop,
};
