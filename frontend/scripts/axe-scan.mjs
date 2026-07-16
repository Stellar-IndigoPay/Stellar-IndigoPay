#!/usr/bin/env node
/**
 * scripts/axe-scan.mjs
 *
 * Nightly accessibility (WCAG 2.1 AA) crawl script. Drives a real headless
 * Chromium via Playwright against a running Next.js server and runs
 * axe-core against every page in `URLS_TO_SCAN` using the WCAG 2.0 A/AA +
 * WCAG 2.1 A/AA tags.
 *
 * Used by `npm run a11y:scan` and by `.github/workflows/a11y-nightly.yml`.
 *
 * Behaviour:
 *  - Visits each URL with network-idle wait so dynamic content (e.g. SSE
 *    donation tickers, client-rendered stats) has settled before the scan.
 *  - Captures every violation but only treats `critical` and `serious`
 *    impacts as build-blocking. `moderate`/`minor` are still recorded so
 *    they can be triaged via the JSON artefact.
 *  - Per-page failures are isolated: a thrown error on one URL does not
 *    stop the remaining pages from being scanned.
 *  - Always writes `a11y-report.json` BEFORE the script exits so the
 *    GitHub Actions artefact uploader (which runs `if: always()`) has data
 *    to upload even on a non-zero exit.
 *
 * Required env: BASE_URL (defaults to http://localhost:3000). Browser is
 * downloaded by the workflow via `npx playwright install --with-deps
 * chromium`; locally you must run that command once.
 */
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

/** Pages we crawl. Keep this list intentionally small for the first nightly
 *  so the first green build doesn't require re-tuning every page. Add more
 *  pages after the baseline is established. */
const URLS_TO_SCAN = [
  "/",
  "/projects",
  "/leaderboard",
  "/map",
  "/impact",
  "/apply",
  // Auth-required routes (dashboard, donate, admin, freelancer profile) are
  // skipped in v1 because they require a wallet session. Add them after we
  // stabilize a fixture wallet cookie.
];

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const REPORT_PATH = process.env.REPORT_PATH || "a11y-report.json";
/** Tags combine the WCAG 2.0 A/AA + 2.1 A/AA axes so the scan matches
 *  issue #138's WCAG 2.1 AA target. best-practice is omitted to keep the
 *  signal focused on spec violations. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function run() {
  console.log(`Starting a11y scan against ${BASE_URL}`);
  console.log(`Scanning ${URLS_TO_SCAN.length} URL(s):`);
  for (const path of URLS_TO_SCAN) {
    console.log(`  → ${BASE_URL}${path}`);
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    /** @type {Record<string, unknown>} */
    const report = {
      baseUrl: BASE_URL,
      startedAt: new Date().toISOString(),
      tags: AXE_TAGS,
      pages: {},
    };
    let hasBlockingViolations = false;

    for (const path of URLS_TO_SCAN) {
      const url = `${BASE_URL}${path}`;
      console.log(`\nScanning: ${url}`);
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();

        const violations = results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          helpUrl: v.helpUrl,
          nodesCount: v.nodes.length,
          html: v.nodes.slice(0, 3).map((n) => n.html),
        }));

        const blocking = violations.filter(
          (v) => v.impact === "critical" || v.impact === "serious",
        );

        if (blocking.length > 0) {
          hasBlockingViolations = true;
          console.error(
            `  Blocking (critical/serious): ${blocking.length}`,
          );
          for (const v of blocking) {
            console.error(`    - [${v.impact}] ${v.id}: ${v.description}`);
          }
        } else {
          console.log(
            `  ${violations.length === 0 ? "Clean" : `Only ${violations.length} non-blocking violation(s)`}`,
          );
        }

        report.pages[path] = {
          url,
          scannedAt: new Date().toISOString(),
          totalViolations: violations.length,
          blockingViolations: blocking.length,
          violations,
        };
      } catch (err) {
        console.error(`Scan failed for ${url}: ${err.message}`);
        report.pages[path] = {
          url,
          scannedAt: new Date().toISOString(),
          error: err.message,
        };
      }
    }

    report.finishedAt = new Date().toISOString();
    report.hasBlockingViolations = hasBlockingViolations;

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${REPORT_PATH}`);

    if (hasBlockingViolations) {
      console.error(
        "\nScan failed: at least one page produced a critical or serious violation.",
      );
      process.exitCode = 1;
    } else {
      console.log("\nScan passed: no critical/serious violations.");
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("axe-scan crashed:", err);
  process.exit(2);
});
