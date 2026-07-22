"use strict";

const logger = require("../../logger");
const pushService = require("../pushService");

async function send({ recipient, title, body, data }) {
  try {
    const result = await pushService.sendPushNotification({
      walletAddress: recipient,
      title,
      body,
      data: { ...data, walletAddress: recipient },
    });
    return { providerId: null, status: result ? "sent" : "skipped" };
  } catch (err) {
    logger.error(
      {
        event: "push_channel_send_failed",
        walletAddress: recipient,
        err: err.message,
      },
      "Push channel send failed",
    );
    return { providerId: null, status: "failed", error: err.message };
  }
}

async function sendToFollowers({ projectId, title, body: _body, data }) {
  try {
    const result = await pushService.sendProjectUpdateNotifications({
      project: { id: projectId },
      update: { id: data?.updateId, title },
    });
    return { providerId: null, status: "sent", tickets: result };
  } catch (err) {
    logger.error(
      { event: "push_channel_broadcast_failed", projectId, err: err.message },
      "Push channel broadcast failed",
    );
    return { providerId: null, status: "failed", error: err.message };
  }
}

module.exports = { send, sendToFollowers };
