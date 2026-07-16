# Accessibility (A11y) Scanner

This directory hosts the **nightly WCAG 2.1 AA crawl** used to confirm the
acceptance criterion from issue #138:

> Axe DevTools reports zero critical or serious violations on every page.

It uses [Playwright](https://playwright.dev/) (headless Chromium) and
[`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)
to evaluate the **real DOM** of every URL in `URLS_TO_SCAN`, against the
`wcag2a / wcag2aa / wcag21a / wcag21aa` ruleset.

## Running locally

```bash
# 1. Install new dev dependencies
npm install

# 2. Install the headless browser (one-time; ~150 MB)
npx playwright install --with-deps chromium

# 3. Build and serve the app
npm run build
npm run start &

# 4. Run the scanner
npm run a11y:scan
```

The script writes `a11y-report.json` to the project root and exits with a
**non-zero status** whenever it found at least one **critical** or
**serious** violation. `moderate` / `minor` issues are recorded but do
not fail the script — they appear in the JSON artefact for triage.

## Running in CI

The script is invoked by
`.github/workflows/a11y-nightly.yml` every day at **06:00 UTC**, and on
demand via the Actions tab. Reports are uploaded as workflow artefacts
for review.

## Adding a new page

Append the path (e.g. `/governance`) to `URLS_TO_SCAN` in
`axe-scan.mjs`. Auth-gated pages (dashboard, donate, admin, freelancer
profile) require a fixture wallet cookie — add those when a stable test
session is available.
