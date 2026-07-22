"use strict";

const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { sendOnboardingEmail } = require("./email");

function buildOnboardingChecklist() {
  return [
    {
      key: "verify_wallet",
      label: "Verify wallet ownership",
      completed: false,
    },
    {
      key: "configure_webhook",
      label: "Configure webhook endpoint",
      completed: false,
    },
    {
      key: "create_campaign",
      label: "Create your first campaign",
      completed: false,
    },
    {
      key: "post_update",
      label: "Post a project update",
      completed: false,
    },
    {
      key: "share_widget",
      label: "Embed donation widget on your site",
      completed: false,
    },
  ];
}

async function onboardProject(verificationRequest) {
  if (!verificationRequest || typeof verificationRequest !== "object") {
    throw new Error("verificationRequest is required");
  }

  const projectId = uuid();
  const webhookSecret = crypto.randomBytes(32).toString("hex");
  const projectName = verificationRequest.projectName || "Untitled Project";
  const projectDescription = verificationRequest.projectDescription || "";
  const projectCategory = verificationRequest.projectCategory || "Other";
  const projectLocation = verificationRequest.projectLocation || "";
  const walletAddress = verificationRequest.walletAddress;
  const contactEmail = verificationRequest.contactEmail;

  if (!walletAddress || !contactEmail) {
    throw new Error("verificationRequest.walletAddress and contactEmail are required");
  }

  const existingProject = await pool.query(
    "SELECT id, webhook_secret FROM projects WHERE wallet_address = $1 AND name = $2",
    [walletAddress, projectName],
  );

  let createdProjectId = projectId;
  let finalWebhookSecret = webhookSecret;
  if (existingProject.rows[0]) {
    createdProjectId = existingProject.rows[0].id;
    finalWebhookSecret = existingProject.rows[0].webhook_secret || webhookSecret;
    if (!existingProject.rows[0].webhook_secret) {
      await pool.query(
        "UPDATE projects SET webhook_secret = $1, updated_at = NOW() WHERE id = $2",
        [finalWebhookSecret, createdProjectId],
      );
    }
  } else {
    await pool.query(
      `INSERT INTO projects (
         id, name, description, category, location, wallet_address,
         co2_offset_kg, status, verified, on_chain_verified, webhook_secret,
         verification_request_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'active', true, false, $7, $8, NOW(), NOW())`,
      [
        createdProjectId,
        projectName,
        projectDescription,
        projectCategory,
        projectLocation,
        walletAddress,
        finalWebhookSecret,
        verificationRequest.id,
      ],
    );
  }

  const checklist = buildOnboardingChecklist();
  await pool.query(
    `INSERT INTO project_onboarding (project_id, items)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO NOTHING`,
    [createdProjectId, JSON.stringify(checklist)],
  );

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const dashboardUrl = `${appUrl.replace(/\/$/, "")}/dashboard`;
  const setupGuideUrl = `${appUrl.replace(/\/$/, "")}/docs/getting-started`;

  await sendOnboardingEmail({
    to: contactEmail,
    projectName,
    projectId: createdProjectId,
    webhookSecret: finalWebhookSecret,
    webhookUrl: `${appUrl.replace(/\/$/, "")}/projects/${createdProjectId}`,
    dashboardUrl,
    setupGuideUrl,
  });

  return { projectId: createdProjectId, webhookSecret: finalWebhookSecret };
}

module.exports = { onboardProject, buildOnboardingChecklist };
