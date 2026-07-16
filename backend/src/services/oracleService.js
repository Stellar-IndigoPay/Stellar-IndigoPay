const { server: stellarServer, NETWORK_PASSPHRASE, submitTransaction } = require("./stellar");
const { Contract, Address, nativeToScVal, Keypair, Asset, TransactionBuilder } = require("@stellar/stellar-sdk");
const logger = require("../logger");
const { Gauge, Counter, Histogram } = require("prom-client");
const { registry } = require("./metrics");

const UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PRICE_CHANGE_THRESHOLD = 0.02; // 2%

let currentPrice = null;
let lastUpdateTime = null;
let intervalId = null;

// Prometheus metrics
const oraclePriceGauge = new Gauge({
  name: "indigopay_oracle_price",
  help: "Current XLM/USD price",
  registers: [registry],
});

const oracleUpdateCounter = new Counter({
  name: "indigopay_oracle_updates_total",
  help: "Oracle update count",
  registers: [registry],
});

const oracleLatencyHistogram = new Histogram({
  name: "indigopay_oracle_update_seconds",
  help: "Oracle update latency",
  registers: [registry],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

const oraclePriceUpdatedTimestampGauge = new Gauge({
  name: "indigopay_oracle_price_updated_timestamp",
  help: "Timestamp of the last successful oracle update",
  registers: [registry],
});

async function fetchDEXPrice() {
  try {
    const orderbook = await stellarServer
      .orderbook(
        new Asset.native(),
        new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
      )
      .call();
    const bestBid = parseFloat(orderbook.bids[0]?.price || "0");
    const bestAsk = parseFloat(orderbook.asks[0]?.price || "0");
    if (bestBid && bestAsk) {
      return (bestBid + bestAsk) / 2;
    }
    return null;
  } catch (err) {
    logger.warn({ event: "oracle_dex_fetch_error", err: err.message }, "Failed to fetch DEX price");
    return null;
  }
}

async function fetchCoinGeckoPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd");
    const data = await res.json();
    return data.stellar?.usd || null;
  } catch (err) {
    logger.warn({ event: "oracle_coingecko_fetch_error", err: err.message }, "Failed to fetch CoinGecko price");
    return null;
  }
}

async function buildSetPriceTransaction(priceStroops) {
  const oracleContractId = process.env.ORACLE_CONTRACT_ID;
  const adminSecret = process.env.ORACLE_ADMIN_SECRET;

  if (!oracleContractId) {
    throw new Error("ORACLE_CONTRACT_ID not configured");
  }
  if (!adminSecret) {
    throw new Error("ORACLE_ADMIN_SECRET not configured");
  }

  const keypair = Keypair.fromSecret(adminSecret);
  const adminPublicKey = keypair.publicKey();

  const account = await stellarServer.loadAccount(adminPublicKey);
  const contract = new Contract(oracleContractId);

  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "set_price",
        Address.fromString(adminPublicKey).toScVal(),
        nativeToScVal(priceStroops, { type: "i128" })
      )
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

async function updateOracle() {
  const startTime = Date.now();
  try {
    let price = await fetchDEXPrice();
    if (!price) {
      logger.warn({ event: "oracle_dex_failed" }, "DEX price fetch failed, falling back to CoinGecko");
      price = await fetchCoinGeckoPrice();
    }
    if (!price) {
      throw new Error("All price sources failed");
    }

    const priceChange = currentPrice ? Math.abs(price - currentPrice) / currentPrice : 1;
    if (priceChange >= PRICE_CHANGE_THRESHOLD) {
      // The contract expects "XLM stroops per 1 USDC stroop"
      // If XLM = 0.125 USD/USDC, then 1 USDC = 1 / 0.125 = 8 XLM.
      const usdcPriceInXlm = 1 / price;
      const priceStroops = BigInt(Math.round(usdcPriceInXlm * 10_000_000));

      const txXdr = await buildSetPriceTransaction(priceStroops);
      await submitTransaction(txXdr);

      currentPrice = price;
      lastUpdateTime = Date.now();
      oraclePriceGauge.set(price);
      oracleUpdateCounter.inc();
      oraclePriceUpdatedTimestampGauge.set(Math.round(lastUpdateTime / 1000));

      logger.info({ event: "oracle_updated", price, usdcPriceInXlm }, "Oracle price successfully updated on-chain");
    } else {
      // Even if threshold not met, update timestamp and current price gauge to represent fresh checks
      currentPrice = price;
      lastUpdateTime = Date.now();
      oraclePriceGauge.set(price);
      oraclePriceUpdatedTimestampGauge.set(Math.round(lastUpdateTime / 1000));
      logger.debug({ event: "oracle_no_change", price }, "Oracle price checked; change below threshold");
    }
    const latency = (Date.now() - startTime) / 1000;
    oracleLatencyHistogram.observe(latency);
  } catch (err) {
    logger.error({ event: "oracle_update_failed", err: err.message }, "Oracle update cycle failed");
    // We propagate or handle it. For scheduler, we log and do not crash the process.
    throw err;
  }
}

function start() {
  if (intervalId) return;
  
  // Run on startup (ignoring failure so it doesn't crash initialization, but logging it)
  updateOracle().catch((err) => {
    logger.error({ event: "oracle_startup_update_failed", err: err.message }, "Initial oracle update failed");
  });

  intervalId = setInterval(async () => {
    try {
      await updateOracle();
    } catch (err) {
      // Logged in updateOracle
    }
  }, UPDATE_INTERVAL_MS);

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

function getCurrentPrice() {
  return currentPrice;
}

function getLastUpdateTime() {
  return lastUpdateTime;
}

function resetCachedPrice() {
  currentPrice = null;
  lastUpdateTime = null;
}

module.exports = {
  fetchDEXPrice,
  fetchCoinGeckoPrice,
  buildSetPriceTransaction,
  updateOracle,
  start,
  stop,
  getCurrentPrice,
  getLastUpdateTime,
  resetCachedPrice,
  // Export metrics for testing
  oraclePriceGauge,
  oracleUpdateCounter,
  oracleLatencyHistogram,
  oraclePriceUpdatedTimestampGauge,
};
