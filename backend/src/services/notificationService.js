"use strict";

const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const logger = require("../logger");
const inAppChannel = require("./channels/inApp");
const pushChannel = require("./channels/push");
const emailChannel = require("./channels/email");

async function resolveRecipients({ type, projectId, walletAddress }) {
  switch (type) {
  case "project_update":
  case "milestone_reached": {
    const { rows } = await pool.query(
      `SELECT DISTINCT dt.wallet_address
       FROM project_follows pf
       JOIN device_tokens dt ON pf.device_token_id = dt.id
       WHERE pf.project_id = $1 AND dt.wallet_address IS NOT NULL AND dt.is_active = true`,
      [projectId],
    );
    const subs = await pool.query(
      "SELECT email FROM project_subscriptions WHERE project_id = $1",
      [projectId],
    );
    const wallets = rows.map((r) => ({ type: "wallet", address: r.wallet_address }));
    const emails = subs.rows.map((r) => ({ type: "email", address: r.email }));
    return [...wallets, ...emails];
  }
  case "match_applied": {
    if (!projectId) return [];
    const { rows } = await pool.query(
      "SELECT wallet_address FROM projects WHERE id = $1",
      [projectId],
    );
    if (!rows[0]) return [];
    return [{ type: "wallet", address: rows[0].wallet_address }];
  }
  case "verification_status": {
    if (!walletAddress) return [];
    return [{ type: "wallet", address: walletAddress }];
  }
  case "monthly_digest": {
    if (!projectId) return [];
    const subs = await pool.query(
      "SELECT email FROM project_subscriptions WHERE project_id = $1",
      [projectId],
    );
    return subs.rows.map((r) => ({ type: "email", address: r.email }));
  }
  default:
    return [];
  }
}

async function getEnabledChannels(recipient, eventType, projectId) {
  const channels = new Set(["in_app"]);

  if (recipient.type === "wallet") {
    const { rows } = await pool.query(
      `SELECT channel, enabled FROM notification_preferences
       WHERE wallet_address = $1
         AND (project_id IS NULL OR project_id = $2)
         AND (type IS NULL OR type = $3)
       ORDER BY project_id NULLS LAST, type NULLS LAST`,
      [recipient.address, projectId || "", eventType],
    );

    const pushEnabled = rows.some(
      (r) => r.channel === "push" && !r.enabled === false,
    );
    if (!pushEnabled) {
      const hasDevice = await pool.query(
        "SELECT 1 FROM device_tokens WHERE wallet_address = $1 AND is_active = true LIMIT 1",
        [recipient.address],
      );
      if (hasDevice.rows.length > 0) channels.add("push");
    }
  }

  if (recipient.type === "email") {
    channels.add("email");
  }

  return [...channels];
}

async function isRateLimited({ projectId, type, recipient }) {
  if (!projectId) return false;

  const { rows } = await pool.query(
    `SELECT 1 FROM notification_deliveries
     WHERE recipient = $1 AND notification_id = $2
       AND created_at > NOW() - INTERVAL '5 minutes'
     LIMIT 1`,
    [recipient.address || recipient.email, `${type}_${projectId}`],
  );
  return rows.length > 0;
}

async function recordDelivery({
  notificationId,
  recipient,
  channel,
  status,
  providerId,
  error,
}) {
  try {
    await pool.query(
      `INSERT INTO notification_deliveries (id, notification_id, recipient, channel, status, provider_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuid(), notificationId, recipient, channel, status, providerId || null, error || null],
    );
  } catch (err) {
    logger.error(
      { event: "delivery_record_failed", notificationId, err: err.message },
      "Failed to record delivery",
    );
  }
}

async function sendToChannel(channel, recipient, { title, body, data, projectId, text }) {
  switch (channel) {
  case "in_app":
    return inAppChannel.send({
      recipient: recipient.address,
      title,
      body,
      data,
    });
  case "push":
    return pushChannel.send({
      recipient: recipient.address,
      title,
      body,
      data: { ...data, projectId },
    });
  case "email":
    return emailChannel.send({
      recipient: recipient.address,
      subject: title,
      html: body,
      text: text || body.replace(/<[^>]*>/g, ""),
    });
  default:
    return { status: "skipped", error: "unknown_channel" };
  }
}

async function send({ type, projectId, walletAddress, title, body, data }) {
  const notificationId = `${type}_${projectId || walletAddress || "global"}`;
  const results = [];

  const recipients = await resolveRecipients({ type, projectId, walletAddress });

  for (const recipient of recipients) {
    const address = recipient.address;
    if (!address) continue;

    if (await isRateLimited({ projectId, type, recipient })) {
      logger.info(
        { event: "notification_rate_limited", type, recipient: address },
        "Notification rate limited",
      );
      continue;
    }

    const channels = await getEnabledChannels(recipient, type, projectId);

    for (const channel of channels) {
      try {
        const result = await sendToChannel(channel, recipient, {
          title,
          body,
          data: { ...data, type, projectId },
          projectId,
          text: data?.text,
        });

        await recordDelivery({
          notificationId,
          recipient: address,
          channel,
          status: result.status,
          providerId: result.providerId,
          error: result.error,
        });

        results.push({
          recipient: address,
          channel,
          status: result.status,
          providerId: result.providerId,
        });
      } catch (err) {
        await recordDelivery({
          notificationId,
          recipient: address,
          channel,
          status: "failed",
          error: err.message,
        });
        results.push({ recipient: address, channel, status: "failed", error: err.message });
      }
    }
  }

  logger.info(
    { event: "notification_sent", type, projectId, count: results.length },
    `Notification sent: ${type}`,
  );

  return results;
}

module.exports = { send };
