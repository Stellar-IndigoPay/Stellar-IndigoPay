"use strict";

const DEFAULT_LEDGER_SECONDS = 5;

const LEDGER_SECONDS_BY_NETWORK = Object.freeze({
  testnet: DEFAULT_LEDGER_SECONDS,
  mainnet: DEFAULT_LEDGER_SECONDS,
});

function ledgerToMs(ledgers, network = process.env.STELLAR_NETWORK || "testnet") {
  const ledgerCount = Number(ledgers);
  if (!Number.isFinite(ledgerCount) || ledgerCount < 0) {
    return 0;
  }

  const ledgerSeconds =
    LEDGER_SECONDS_BY_NETWORK[network] ?? LEDGER_SECONDS_BY_NETWORK.testnet;

  return Math.round(ledgerCount * ledgerSeconds * 1000);
}

module.exports = {
  DEFAULT_LEDGER_SECONDS,
  LEDGER_SECONDS_BY_NETWORK,
  ledgerToMs,
};
