import type { NextApiRequest, NextApiResponse } from "next";
import { captureEvent } from "@sentry/nextjs";

/**
 * CSP violation reporting endpoint.
 *
 * Accepts both reporting formats so the `report-to` migration in middleware.ts
 * does not drop reports from older browsers:
 *   - Legacy `report-uri` body: `{ "csp-report": { ... } }`
 *   - Reporting API (`report-to`) body: `[{ type: "csp-violation", body: {...} }]`
 */

interface LegacyCspReport {
  "blocked-uri"?: string;
  "violated-directive"?: string;
  "document-uri"?: string;
  "original-policy"?: string;
}

interface ReportingApiReport {
  type?: string;
  body?: {
    blockedURL?: string;
    effectiveDirective?: string;
    documentURL?: string;
    originalPolicy?: string;
  };
}

function logViolation(fields: {
  blockedUri?: string;
  violatedDirective?: string;
  documentUri?: string;
  originalPolicy?: string;
}) {
  console.warn("[CSP Violation]", {
    blockedUri: fields.blockedUri,
    violatedDirective: fields.violatedDirective,
    documentUri: fields.documentUri,
    originalPolicy: fields.originalPolicy?.slice(0, 200),
  });

  // Issue #1096 (WS3): Trusted Types / CSP violations must flow into the
  // alerting pipeline so a policy regression is caught in production, not
  // just in CI. Sentry is already configured app-wide (@sentry/nextjs); a
  // failure here must never break report ingestion, hence the try/catch.
  try {
    captureEvent({
      message: "CSP violation",
      level: "warning",
      tags: {
        blockedUri: fields.blockedUri ?? "(none)",
        violatedDirective: fields.violatedDirective ?? "(unknown)",
      },
      extra: {
        documentUri: fields.documentUri ?? null,
        originalPolicy: fields.originalPolicy?.slice(0, 200) ?? null,
      },
    });
  } catch {
    // Report ingestion must never throw.
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const legacy = (req.body as { "csp-report"?: LegacyCspReport } | undefined)?.[
    "csp-report"
  ];
  if (legacy) {
    logViolation({
      blockedUri: legacy["blocked-uri"],
      violatedDirective: legacy["violated-directive"],
      documentUri: legacy["document-uri"],
      originalPolicy: legacy["original-policy"],
    });
    return res.status(204).end();
  }

  const reports = Array.isArray(req.body)
    ? (req.body as ReportingApiReport[])
    : [];
  for (const report of reports) {
    if (report?.type === "csp-violation" && report.body) {
      logViolation({
        blockedUri: report.body.blockedURL,
        violatedDirective: report.body.effectiveDirective,
        documentUri: report.body.documentURL,
        originalPolicy: report.body.originalPolicy,
      });
    }
  }

  res.status(204).end();
}
