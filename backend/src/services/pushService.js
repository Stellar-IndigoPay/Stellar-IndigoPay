"use strict";

/**
 * src/services/pushService.js
 *
 * Push notification dispatch with multi-provider routing (APNs / FCM / Expo).
 * `pushQueue.js` is the pg-boss worker that calls into this module; this
 * module owns preference checks, provider selection, and delivery tracking.
 *
 * Provider routing is delegated to `pushProviders.js`. The public API of
 * this module is unchanged so callers (pushQueue, routes) need no updates.
 */

const { Expo } = require("expo-server-sdk");
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const logger = require("../logger");
const { sendViaProvider } = require("./pushProviders");

/**
 * Whether a wallet has opted in to push notifications of a given type.
 * No matching row means "opted in" (push defaults to on). A row with
 * type = NULL is a blanket preference for the whole channel; a row with
 * a specific type overrides the blanket one for that type.
 */
/**
 * Check whether the current time falls within the configured DND window.
 * Returns true if notifications should be suppressed right now.
 */
async function isInDndWindow(walletAddress) {
  if (!walletAddress) return false;

  try {
    const { rows } = await pool.query(
      "SELECT notification_dnd FROM profiles WHERE public_key = $1",
      [walletAddress],
    );
    const dnd = rows[0]?.notification_dnd;
    if (!dnd || !dnd.start || !dnd.end) return false;

    const tz = dnd.timezone || "UTC";

    // Parse the current time in the configured timezone using
    // Intl.DateTimeFormat for consistent parsing across Node versions.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const timeStr = fmt.format(new Date());
    const [nowH, nowM] = timeStr.split(":").map(Number);
    const nowMinutes = nowH * 60 + nowM;

    const [startH, startM] = dnd.start.split(":").map(Number);
    const [endH, endM] = dnd.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same-day window (e.g., 08:00–22:00)
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Overnight window (e.g., 22:00–08:00)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  } catch (err) {
    logger.error(
      {
        event: "dnd_check_failed",
        walletAddress,
        err: err.message,
      },
      "Failed to check DND window; defaulting to not suppressing",
    );
    return false;
  }
}

async function shouldSendPush(walletAddress, type) {
  if (!walletAddress) return false;

  try {
    const { rows } = await pool.query(
      `SELECT enabled FROM notification_preferences
       WHERE wallet_address = $1 AND channel = 'push' AND (type = $2 OR type IS NULL)
       ORDER BY (type IS NULL) ASC
       LIMIT 1`,
      [walletAddress, type || null],
    );
    const optedIn = rows.length === 0 ? true : rows[0].enabled;
    if (!optedIn) return false;

    // Honour DND hours
    if (await isInDndWindow(walletAddress)) return false;

    return true;
  } catch (err) {
    logger.error(
      {
        event: "push_preference_check_failed",
        walletAddress,
        err: err.message,
      },
      "Failed to check notification preferences; defaulting to send",
    );
    return true;
  }
}

async function recordDelivery({
  walletAddress,
  message,
  status,
  ticketId,
  errorMessage,
  platform = null,
  provider = null,
}) {
  try {
    await pool.query(
      `INSERT INTO push_notifications
         (id, wallet_address, device_token, title, body, data, status, ticket_id, error_message, platform, provider)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
      [
        uuid(),
        walletAddress || null,
        message.to,
        message.title,
        message.body,
        JSON.stringify(message.data || {}),
        status,
        ticketId || null,
        errorMessage || null,
        platform || null,
        provider || null,
      ],
    );
  } catch (err) {
    logger.error(
      {
        event: "push_delivery_record_failed",
        walletAddress,
        deviceToken: message.to,
        err: err.message,
      },
      "Failed to record push delivery",
    );
  }
}

/**
 * Dispatch a list of device descriptors (each with a token, platform, walletAddress)
 * via the appropriate provider, recording outcomes in push_notifications.
 *
 * Replaces the old Expo-only dispatch().
 *
 * @param {{ token: string, platform: string|null, walletAddress: string|null }[]} devices
 * @param {{ title: string, body: string, data?: object }} payload
 */
async function dispatchToDevices(devices, payload) {
  const results = [];

  for (const device of devices) {
    const result = await sendViaProvider(
      device.token,
      device.platform,
      "auto",
      payload,
    );

    // Map provider outcome to push_notifications.status
    const status =
      result.success || result.outcome === "fallback" ? "sent" : "failed";

    await recordDelivery({
      walletAddress: device.walletAddress,
      message: { to: device.token, ...payload },
      status,
      ticketId: result.providerMessageId || null,
      errorMessage: result.error || null,
      platform: device.platform,
      provider: result.provider,
    });

    // Deactivate stale tokens regardless of provider.
    if (result.unregistered) {
      try {
        await pool.query(
          "UPDATE device_tokens SET is_active = false, updated_at = NOW() WHERE token = $1",
          [device.token],
        );
        logger.info(
          {
            event: "push_stale_token_marked_inactive",
            provider: result.provider,
            deviceToken: device.token,
            walletAddress: device.walletAddress,
          },
          "Auto-marked stale device token as inactive",
        );
      } catch (err) {
        logger.error(
          {
            event: "push_stale_token_mark_failed",
            deviceToken: device.token,
            err: err.message,
          },
          "Failed to mark stale token inactive",
        );
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Send a push notification to every device registered for a wallet
 * address, honoring that donor's push preferences for `data.type`.
 */
async function sendPushNotification({ walletAddress, title, body, data = {} }) {
  if (!(await shouldSendPush(walletAddress, data.type))) return null;

  const { rows: tokens } = await pool.query(
    "SELECT token, platform FROM device_tokens WHERE wallet_address = $1 AND is_active = true",
    [walletAddress],
  );

  const devices = tokens.map((row) => ({
    token: row.token,
    platform: row.platform || null,
    walletAddress,
  }));

  const payload = { title, body, data: { ...data, walletAddress } };
  return dispatchToDevices(devices, payload);
}

async function sendDonationReceipt(donorAddress, donation) {
  return sendPushNotification({
    walletAddress: donorAddress,
    title: "Donation Received! \u{1F331}",
    body: `${donation.amount} ${donation.currency} donated to ${donation.projectName}`,
    data: {
      type: "donation_receipt",
      projectId: donation.projectId,
      donationId: donation.id,
    },
  });
}

/**
 * Notify every wallet-linked follower that a governance proposal is open
 * for voting. Proposals are identified by their on-chain proposalId;
 * the deep link should open the governance voting screen.
 *
 * Batches token lookups into a single JOIN query (same pattern as
 * sendProjectUpdateNotifications) to avoid N+1 DB round-trips.
 */
async function sendGovernanceProposalNotifications({
  proposalId,
  title,
  description,
  endsAt,
}) {
  const { rows: followers } = await pool.query(
    `SELECT DISTINCT dt.token, dt.wallet_address, dt.platform
     FROM device_tokens dt
     WHERE dt.wallet_address IS NOT NULL
       AND dt.is_active = true`,
  );

  const shortBody =
    description && description.length > 120
      ? description.slice(0, 117) + "..."
      : description || "A new proposal is open for voting";

  const data = {
    type: "governance_proposal",
    proposalId,
    ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
  };

  const messages = [];
  for (const row of followers) {
    if (
      row.wallet_address &&
      !(await shouldSendPush(row.wallet_address, data.type))
    ) {
      continue;
    }
    messages.push({
      token: row.token,
      platform: row.platform || null,
      walletAddress: row.wallet_address || null,
    });
  }

  const sendPayload = {
    title: `Governance: ${title}`,
    body: shortBody,
    data,
  };

  const devices = messages.map((m) => ({
    token: m.token,
    platform: m.platform,
    walletAddress: m.walletAddress,
  }));

  return dispatchToDevices(devices, sendPayload);
}

/**
 * Send a recurring donation reminder to a specific donor 24h before
 * their scheduled payment is due. Called by the recurring donation
 * scheduler (or cron job) for each donor with an upcoming payment.
 */
async function sendRecurringReminder({
  donorAddress,
  projectName,
  amount,
  currency,
  projectId,
  nextPaymentDate,
  recurringId,
}) {
  const payloadData = {
    type: "recurring_reminder",
    projectId,
    recurringId,
    ...(nextPaymentDate
      ? { nextPaymentDate: new Date(nextPaymentDate).toISOString() }
      : {}),
  };

  return sendPushNotification({
    walletAddress: donorAddress,
    title: "Upcoming Donation Reminder \u{1F4AC}",
    body: `Your ${amount} ${currency} recurring donation to ${projectName} will be processed tomorrow`,
    data: payloadData,
  });
}

/**
 * Notify every wallet-linked follower of a project that a funding
 * milestone was reached. Anonymous (wallet-less) follows have no
 * identity to check preferences against, so they're skipped here — see
 * sendProjectUpdateNotifications for the device-token broadcast used by
 * project updates, which does include them.
 */
async function sendMilestoneReachedNotifications({
  projectId,
  projectName,
  percentage,
}) {
  const { rows: followers } = await pool.query(
    `SELECT DISTINCT wallet_address
     FROM project_follows
     WHERE project_id = $1 AND wallet_address IS NOT NULL`,
    [projectId],
  );

  const results = [];
  for (const follower of followers) {
    results.push(
      await sendPushNotification({
        walletAddress: follower.wallet_address,
        title: "Milestone Reached! \u{1F389}",
        body: `${projectName} has reached its ${percentage}% funding milestone!`,
        data: { type: "milestone_reached", projectId },
      }),
    );
  }
  return results;
}

/**
 * Broadcast a project update to every follower's device, wallet-linked
 * or not. Wallet-linked follows are preference-checked like every other
 * push; anonymous device follows have no identity to check preferences
 * against, so they're always sent.
 */
async function sendProjectUpdateNotifications({ project, update }) {
  const { rows: followers } = await pool.query(
    `SELECT dt.token, dt.wallet_address, dt.platform
     FROM project_follows pf
     JOIN device_tokens dt ON pf.device_token_id = dt.id
     WHERE pf.project_id = $1 AND dt.is_active = true`,
    [project.id],
  );

  const title = `Update: ${project.name}`;
  const body = update.title;
  const data = {
    type: "project_update",
    projectId: project.id,
    updateId: update.id,
  };

  const messages = [];
  const walletAddresses = [];
  for (const row of followers) {
    if (!Expo.isExpoPushToken(row.token)) {
      logger.warn(
        {
          event: "push_invalid_token",
          projectId: project.id,
          token: row.token,
        },
        "Skipping token not usable as Expo push token (native tokens handled by platform providers)",
      );
    }
    if (
      row.wallet_address &&
      !(await shouldSendPush(row.wallet_address, data.type))
    ) {
      continue;
    }
    messages.push({
      token: row.token,
      platform: row.platform || null,
      walletAddress: row.wallet_address || null,
    });
    walletAddresses.push(row.wallet_address || null);
  }

  const sendPayload = {
    title,
    body,
    data,
  };
  // Build device list for multi-provider dispatch
  const devices = messages.map((m) => ({
    token: m.token,
    platform: m.platform,
    walletAddress: m.walletAddress,
  }));
  return dispatchToDevices(devices, sendPayload);
}

module.exports = {
  sendPushNotification,
  sendDonationReceipt,
  sendMilestoneReachedNotifications,
  sendProjectUpdateNotifications,
  sendGovernanceProposalNotifications,
  sendRecurringReminder,
  shouldSendPush,
};
