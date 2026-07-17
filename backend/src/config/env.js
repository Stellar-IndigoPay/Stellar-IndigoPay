"use strict";
const { z } = require("zod");

const envSchema = z.object({
  // DATABASE_URL is technically required in production, but the rest of
  // the codebase (notably db/pool.js) falls back to localhost when it's
  // unset. We mirror that here so that test environments can boot the
  // app without needing a real Postgres instance.
  DATABASE_URL: z
    .string()
    .optional()
    .default("postgres://postgres:postgres@localhost:5432/indigopay"),
  DATABASE_REPLICA_URL: z.string().optional().default(""),
  MAX_REPLICA_LAG_MS: z.string().optional().default("5000"),
  PORT: z.string().optional().default("4000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .optional()
    .default("development"),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).optional().default("testnet"),
  HORIZON_URL: z
    .string()
    .url()
    .optional()
    .default("https://horizon-testnet.stellar.org"),
  ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
  CONTRACT_ID: z.string().optional().default(""),
  ORACLE_CONTRACT_ID: z.string().optional().default(""),
  ORACLE_ADMIN_SECRET: z.string().optional().default(""),
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z
    .string()
    .optional()
    .default("Stellar-IndigoPay <updates@stellarindigopay.app>"),
  APP_URL: z.string().optional().default("http://localhost:3000"),
  UNSUBSCRIBE_SECRET: z.string().optional().default(""),
  JWT_SECRET: z.string().optional().default(""),
  ADMIN_USERNAME: z.string().optional().default("admin"),
  ADMIN_PASSWORD: z.string().optional().default(""),
  ADMIN_API_KEY: z.string().optional().default(""),
  ADMIN_API_KEYS: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  REDIS_URL: z.string().optional().default("redis://localhost:6379"),
  ENABLE_TURRETS: z.enum(["true", "false"]).optional().default("false"),
  TURRETS_PORT: z.string().optional().default("3001"),
  // Verification request admin notification target (defaults to EMAIL_FROM).
  ADMIN_NOTIFICATION_EMAIL: z.string().optional().default(""),
  // Document storage backend for the /apply form (local|s3|ipfs)
  STORAGE_BACKEND: z.enum(["local", "s3", "ipfs"]).optional().default("local"),
  UPLOAD_MAX_BYTES: z
    .string()
    .optional()
    .default(String(10 * 1024 * 1024)),
  // Optional S3 / IPFS knobs; only consulted when STORAGE_BACKEND matches.
  AWS_REGION: z.string().optional().default(""),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_BUCKET: z.string().optional().default(""),
  S3_PUBLIC_URL: z.string().optional().default(""),
  IPFS_API_URL: z.string().optional().default(""),
  IPFS_GATEWAY_URL: z.string().optional().default(""),
  // web3.storage token for pinning verification documents to IPFS. When
  // set (or IPFS_API_URL is), /apply supporting documents are mirrored to
  // IPFS and their CID stored in supporting_documents.
  WEB3_STORAGE_API_KEY: z.string().optional().default(""),
  IPFS_FALLBACK_TO_LOCAL: z
    .enum(["true", "false"])
    .optional()
    .default("true"),
  IPFS_TIMEOUT_MS: z.string().optional().default("30000"),

  // ── Observability / metrics ────────────────────────────────────────────────
  // When METRICS_ENABLED=false the /metrics endpoint returns 404. Defaults
  // to true so the endpoint is available out of the box in dev.
  METRICS_ENABLED: z.enum(["true", "false"]).optional().default("true"),
  // Bearer token required to scrape /metrics. If unset, the endpoint is
  // unauthenticated (intended for local dev only).
  METRICS_BEARER_TOKEN: z.string().optional().default(""),
  // Sentry tracing sample rate. 0 disables, 1 samples everything. Production
  // default 0.1 (10% of transactions). Anything above 0.5 gets expensive.
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional().default("0.1"),

  // ── USDC donation indexing ───────────────────────────────────────────────
  // USDC token contract address on Stellar. Required for the indexer to
  // detect and record USDC payments. If unset, the indexer skips USDC
  // detection and logs a warning.
  USDC_TOKEN_ADDRESS: z.string().optional().default(""),
  // Conversion rate from USDC to XLM for CO₂ offset calculation and
  // raised_xlm increment. Default 8.0 means 1 USDC = 8 XLM.
  USDC_TO_XLM_RATE: z.string().optional().default("8.0"),

  // ── Rate limiter ──────────────────────────────────────────────────────────
  RATE_LIMIT_MAX: z.string().optional().default("150"),

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // Hard deadline for the drain. After this we exit(1) regardless of state.
  SHUTDOWN_TIMEOUT_MS: z.string().optional().default("30000"),

  // ── Readiness probe ───────────────────────────────────────────────────────
  // READINESS_REQUIRE_REDIS=true makes /api/readyz fail when Redis is down.
  // Default false because Redis is an optional cache, not a hard dependency.
  READINESS_REQUIRE_REDIS: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  // Per-subsystem check timeout. Coupled with DB_POOL_CONNECT_TIMEOUT and
  // DB_STATEMENT_TIMEOUT_MS: their sum must stay under this value so a
  // slow DB can never block the probe past its own deadline.
  READINESS_CHECK_TIMEOUT_MS: z.string().optional().default("4000"),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // zod v4 renamed `error.errors` to `error.issues`. Fall back to
    // `errors` for any v3 shim that still defines it.
    const issues = (result.error.issues || result.error.errors || [])
      .map((e) => `  - ${(e.path || []).join(".")}: ${e.message}`)
      .join("\n");
    console.error(`\n[Startup] Environment validation failed:\n${issues}\n`);
    process.exit(1);
  }

  return result.data;
}

module.exports = { validateEnv };
