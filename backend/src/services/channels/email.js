"use strict";

const logger = require("../../logger");

async function send({ recipient, subject, html, text }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
  if (!RESEND_API_KEY) {
    logger.warn(
      { event: "email_channel_no_key" },
      "RESEND_API_KEY not set — skipping email",
    );
    return { providerId: null, status: "skipped", error: "no_api_key" };
  }

  const FROM_ADDRESS =
    process.env.EMAIL_FROM ||
    "Stellar-IndigoPay <updates@stellarindigopay.app>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [recipient],
        subject,
        html,
        text,
        headers: {
          "List-Unsubscribe": `<${process.env.APP_URL || "http://localhost:3000"}/unsubscribe>`,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error(
        { event: "email_channel_resend_error", recipient, err: errBody },
        "Resend email failed",
      );
      return { providerId: null, status: "failed", error: errBody };
    }

    const body = await res.json();
    return { providerId: body.id || null, status: "sent" };
  } catch (err) {
    logger.error(
      { event: "email_channel_send_failed", recipient, err: err.message },
      "Email channel send failed",
    );
    return { providerId: null, status: "failed", error: err.message };
  }
}

module.exports = { send };
