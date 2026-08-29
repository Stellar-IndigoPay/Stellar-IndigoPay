const crypto = require("crypto");
const pool = require("../db/pool");
const { UUID_RE } = require("../validators/schemas");
const { metrics } = require("../services/metrics");

/**
 * Placeholder response stored while the first request is still processing.
 */
const PROCESSING_PLACEHOLDER = JSON.stringify({ status: "processing" });

/**
 * Re-read an idempotency row and reply with its stored response. Used on the
 * race-losing path (another request's INSERT won the ON CONFLICT race) and as
 * the fast replay path for already-recorded keys.
 *
 * @param {import('express').Response} res
 * @param {{request_body_hash: string, response_status: number, response_body: unknown}} row
 * @param {string} expectedBodyHash - hash of the current request body
 * @returns {boolean} true when a response was sent (caller must stop)
 */
function replayStoredResponse(res, row, expectedBodyHash) {
  if (row.request_body_hash !== expectedBodyHash) {
    res.status(409).json({ error: "Idempotency key reused with different request body" });
    return true;
  }
  res.status(row.response_status).json(row.response_body);
  return true;
}

function hashBody(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");
}

async function idempotencyMiddleware(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key || typeof key !== "string" || key.length > 256) return next();
  if (!UUID_RE.test(key)) return res.status(400).json({ error: "Idempotency-Key must be a valid UUID" });

  const bodyHash = hashBody(req.body);

  try {
    const existing = await pool.query(
      "SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()",
      [key]
    );

    if (existing.rows[0]) {
      return replayStoredResponse(res, existing.rows[0], bodyHash);
    }

    // Store the placeholder atomically. `ON CONFLICT (key) DO NOTHING
    // RETURNING key` resolves the read-then-insert race at the database level:
    // exactly one of two concurrent requests with the same key wins the INSERT;
    // the loser gets an empty RETURNING and must re-read the winner's row
    // instead of proceeding (issue #1102, Part B).
    const inserted = await pool.query(
      `INSERT INTO idempotency_keys (key, request_body_hash, response_status, response_body)
       VALUES ($1, $2, 202, $3)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, bodyHash, PROCESSING_PLACEHOLDER]
    );

    if (!inserted.rows[0]) {
      // Another concurrent request won the race for this key. Do NOT process
      // the request — re-read the winner's row and replay its stored response
      // (or surface the body-conflict error).
      const winner = await pool.query(
        "SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()",
        [key]
      );
      metrics.idempotencyRaceWinsTotal.inc({ outcome: "lost" });
      if (winner.rows[0]) {
        return replayStoredResponse(res, winner.rows[0], bodyHash);
      }
      // The winner's row expired mid-race; fall through and treat this as a
      // brand-new request.
    } else {
      metrics.idempotencyRaceWinsTotal.inc({ outcome: "won" });
    }

    // Override res.json to capture and persist the response (winner path).
    // Persistence happens BEFORE the response is sent: once the client sees
    // the final response, an immediate replay must read the stored response
    // — not the 202 "processing" placeholder (issue #1102, Part B). If the
    // persistence write fails, still respond (best-effort, never block).
    const originalJson = res.json.bind(res);
    res.json = function(body) {
      const respond = () => originalJson(body);
      pool
        .query(
          "UPDATE idempotency_keys SET response_body = $1, response_status = $2 WHERE key = $3",
          [JSON.stringify(body), res.statusCode, key],
        )
        .then(respond)
        .catch(() => respond());
      return res;
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = idempotencyMiddleware;
