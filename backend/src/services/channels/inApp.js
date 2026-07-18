"use strict";

const { v4: uuid } = require("uuid");
const pool = require("../../db/pool");
const logger = require("../../logger");

async function send({ recipient, title, body, data }) {
  const id = uuid();
  try {
    await pool.query(
      `INSERT INTO in_app_notifications (id, wallet_address, title, body, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, recipient, title, body, JSON.stringify(data || {})],
    );
    return { providerId: id, status: "sent" };
  } catch (err) {
    logger.error(
      { event: "in_app_insert_failed", walletAddress: recipient, err: err.message },
      "Failed to insert in-app notification",
    );
    return { providerId: null, status: "failed", error: err.message };
  }
}

module.exports = { send };
