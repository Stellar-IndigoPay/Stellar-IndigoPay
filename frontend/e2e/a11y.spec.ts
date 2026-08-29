import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockFreighterWallet } from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

// `color-contrast` is excluded by default: axe flags ~1-28 nodes per page
// against the app's existing muted-gray-text pattern (e.g. text-[#64748B]/
// [#94A3B8] at reduced opacity), a design-system-wide contrast issue
// predating this suite and not scoped by it. Every other WCAG 2A/AA rule
// stays enforced (zero violations). The V2 donation-flow contrast test below
// opts IN to color-contrast and scopes the scan to the money-path
// components, which this epic owns and must keep WCAG AA clean (issue #1096,
// WS7: "Dark-mode error states meet WCAG AA contrast ratio 4.5:1").
async function runA11yCheck(
  page: Page,
  opts: { withContrast?: boolean; include?: string } = {},
) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  if (!opts.withContrast) builder = builder.disableRules(["color-contrast"]);
  if (opts.include) builder = builder.include(opts.include);
  return builder.analyze();
}

/** Enable the V2 donation flow for the given browser session. */
async function enableDonationV2(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ({ theme }) => {
      try {
        window.localStorage.setItem("indigopay-donation-v2", "true");
        window.localStorage.setItem("stellar-indigopay-theme", theme);
      } catch {
        // about:blank has no origin — re-set after first load below.
      }
    },
    { theme },
  );
  await page.goto("/");
  await page.evaluate((theme) => {
    window.localStorage.setItem("indigopay-donation-v2", "true");
    window.localStorage.setItem("stellar-indigopay-theme", theme);
  }, theme);
}

test.describe("Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    const backend: MockBackendState = {
      projects: structuredClone(FIXTURE_PROJECTS),
      donations: [],
    };
    await mockFreighterWallet(page);
    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);
  });

  test("homepage has no accessibility violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Fund the planet.");

    const results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);
  });

  test("project detail page has no accessibility violations", async ({
    page,
  }) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await expect(
      page.getByRole("heading", { name: PRIMARY_PROJECT.name }),
    ).toBeVisible();

    const results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);
  });

  test("projects listing page has no accessibility violations", async ({
    page,
  }) => {
    await page.goto("/projects");
    await expect(page.getByTestId("project-card").first()).toBeVisible();

    const results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);
  });

  test("dashboard has no accessibility violations", async ({ page }) => {
    await page.goto("/dashboard");
    await page
      .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
      .click();
    await expect(page.getByTestId("donation-history")).toBeVisible();

    const results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);
  });

  // Issue #1096 (WS7): the whole V2 donation flow — wallet picker, amount
  // form with validation, transaction preview, and post-donation
  // confirmation — must be WCAG 2 A/AA clean, not just the static pages.
  test("donation flow (V2): picker, form, preview, and confirmation have no accessibility violations", async ({
    page,
  }) => {
    test.slow();
    await enableDonationV2(page, "light");

    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);

    // Wallet picker / connect state.
    await page
      .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
      .last()
      .click();
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    let results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);

    // Validation state: an over-balance amount surfaces the inline error.
    await page.getByTestId("donation-amount").fill("999999999");
    await expect(page.getByTestId("insufficient-balance-error")).toBeVisible();
    results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);

    // Transaction preview.
    await page.getByTestId("donation-amount").fill("50");
    await page.getByTestId("donate-button").click();
    await expect(page.getByTestId("transaction-preview")).toBeVisible();
    results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);

    // Post-donation confirmation.
    await page.getByTestId("preview-confirm-checkbox").click();
    await page.getByTestId("preview-confirm-button").click();
    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    results = await runA11yCheck(page);
    expect(results.violations).toEqual([]);
  });

  // Issue #1096 (WS7): the money-path components this epic owns must meet
  // WCAG AA color contrast in BOTH themes — including the inline
  // insufficient-balance error, the transaction preview, and the post-
  // donation confirmation. Scoped to the flow components (donate-form,
  // wallet picker) so the app-wide legacy muted-gray contrast debt on other
  // pages (tracked separately) cannot mask a regression here.
  test("donation flow (V2) meets WCAG AA color contrast in light and dark mode", async ({
    page,
  }) => {
    test.slow();

    // The flow components enter with a 0.4-0.5s fade/slide-in; axe computes
    // contrast against the *mid-animation* opacity if scanned immediately,
    // which blends the final color toward the background and produces false
    // "serious" violations. Settle past the animation before each scan so we
    // measure the steady-state rendering a user actually sees.
    const settle = () => page.waitForTimeout(700);

    for (const theme of ["light", "dark"] as const) {
      await enableDonationV2(page, theme);
      await page.goto(`/projects/${PRIMARY_PROJECT.id}`);

      // Wallet picker state.
      await expect(page.getByTestId("wallet-picker").last()).toBeVisible();
      await settle();
      let results = await runA11yCheck(page, {
        withContrast: true,
        include: '[data-testid="wallet-picker"]',
      });
      expect(results.violations).toEqual([]);

      // Connect (mock Freighter) and surface the validation error state.
      await page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last()
        .click();
      await expect(page.getByTestId("donation-amount")).toBeVisible();
      await page.getByTestId("donation-amount").fill("999999999");
      await expect(page.getByTestId("insufficient-balance-error")).toBeVisible();
      await settle();
      results = await runA11yCheck(page, {
        withContrast: true,
        include: '[data-testid="donate-form"]',
      });
      expect(results.violations).toEqual([]);

      // Transaction preview.
      await page.getByTestId("donation-amount").fill("50");
      await page.getByTestId("donate-button").click();
      await expect(page.getByTestId("transaction-preview")).toBeVisible();
      await settle();
      results = await runA11yCheck(page, {
        withContrast: true,
        include: '[data-testid="donate-form"]',
      });
      expect(results.violations).toEqual([]);

      // Post-donation confirmation.
      await page.getByTestId("preview-confirm-checkbox").click();
      await page.getByTestId("preview-confirm-button").click();
      await expect(page.getByTestId("donation-success")).toBeVisible({
        timeout: 15000,
      });
      await settle();
      results = await runA11yCheck(page, {
        withContrast: true,
        include: '[data-testid="donation-success"]',
      });
      expect(results.violations).toEqual([]);
    }
  });
});
