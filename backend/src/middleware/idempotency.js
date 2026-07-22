const crypto = require("crypto");
const pool = require("../db/pool");

function hashBody(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");
}

async function idempotencyMiddleware(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key || typeof key !== "string" || key.length > 256) return next();

  const bodyHash = hashBody(req.body);

  try {
    const existing = await pool.query(
      "SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()",
      [key]
    );

    if (existing.rows[0]) {
      if (existing.rows[0].request_body_hash !== bodyHash) {
        return res.status(409).json({
          error: "Idempotency key reused with different request body",
        });
      }
      return res.status(existing.rows[0].response_status).json(existing.rows[0].response_body);
    }

    // Store placeholder before processing
    await pool.query(
      "INSERT INTO idempotency_keys (key, request_body_hash, response_status, response_body) VALUES ($1, $2, 202, $3)",
      [key, bodyHash, JSON.stringify({ status: "processing" })]
    );

    // Override res.json to capture and persist the response
    const originalJson = res.json.bind(res);
    res.json = function(body) {
      pool.query(
        "UPDATE idempotency_keys SET response_body = $1, response_status = $2 WHERE key = $3",
        [JSON.stringify(body), res.statusCode, key]
      ).catch(() => {});
      return originalJson(body);
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = idempotencyMiddleware;
