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
 *  - Visits each URL and waits for the `load` event plus a short settle delay
 *    so client-rendered content has populated before the scan.  `networkidle`
 *    is deliberately NOT used because SSE streams (Horizon EventSource)
 *    keep a persistent connection open and would cause a 30 s timeout on
 *    every page that streams live donation data.
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
  // intentionally NOT in this static crawl — they require a connected wallet
  // and a mocked backend/Horizon, which this crawler does not provision.  The
  // donation flow (issue #1096 WS7 #7: wallet picker, amount form with
  // validation errors, transaction preview, post-donation confirmation) is
  // covered by the dedicated e2e/a11y.spec.ts, invoked directly from
  // a11y-nightly.yml alongside this script.
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
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        // Let client-side rendering and async data settle.
        await page.waitForTimeout(2000);

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
        hasBlockingViolations = true;
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
      const errored = Object.entries(report.pages)
        .filter(([, p]) => p.error)
        .map(([path]) => path);
      const blocking = Object.entries(report.pages)
        .filter(([, p]) => p.blockingViolations > 0);

      if (errored.length > 0) {
        console.error(
          `\nScan failed: ${errored.length} page(s) could not be scanned: ${errored.join(", ")}`,
        );
      }
      if (blocking.length > 0) {
        console.error(
          `\nScan failed: ${blocking.length} page(s) have critical/serious a11y violations.`,
        );
      }
      if (errored.length === 0 && blocking.length === 0) {
        console.error("\nScan failed for an unknown reason.");
      }
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
