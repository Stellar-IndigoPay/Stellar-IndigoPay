import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const report = req.body?.["csp-report"];
  if (report) {
    console.warn("[CSP Violation]", {
      blockedUri: report["blocked-uri"],
      violatedDirective: report["violated-directive"],
      documentUri: report["document-uri"],
      originalPolicy: report["original-policy"]?.slice(0, 200),
    });
  }
  res.status(204).end();
}
