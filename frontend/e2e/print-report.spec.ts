import { test, expect } from "@playwright/test";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS } from "./fixtures/projects";

/**
 * e2e/print-report.spec.ts — issue #1096, Workstream 3 regression.
 *
 * The print report builds an HTML document in memory and writes it with
 * document.write, so plain-text user fields interpolated without escaping
 * become executable markup when a donor opens the report.  This spec crafts
 * a project whose name/location/category/walletAddress carry stored-XSS
 * payloads, opens the real print flow, and asserts the generated document
 * escapes every field — proving no payload survives into the print window.
 */
const XSS_PAYLOADS = {
  name: "<img src=x onerror=window.__pwned=1>Forest",
  location: "<script>window.__pwned=2</script>Brazil",
  category: 'Reforestation" autofocus onfocus="window.__pwned=3',
  walletAddress: "<svg onload=window.__pwned=4>GABC",
};

test.describe("Print report — stored-XSS defense (issue #1096 WS3)", () => {
  test("escapes every user-controlled field in the generated print document", async ({
    page,
  }) => {
    const [project] = structuredClone(FIXTURE_PROJECTS);
    Object.assign(project, XSS_PAYLOADS);
    const backend: MockBackendState = {
      projects: [project],
      donations: [],
    };
    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);

    const popupPromise = page.waitForEvent("popup");
    await page.goto(`/projects/${project.id}`);
    const reportButton = page.getByRole("button", { name: /Download Report/i });
    await expect(reportButton).toBeVisible();
    await reportButton.click();

    const popup = await popupPromise;
    // The print window is about:blank until document.write() runs.
    await expect
      .poll(async () => (await popup.content()).includes("Impact Report"))
      .toBe(true);

    const html = await popup.content();

    // Plain-text fields are HTML-escaped — the payload never becomes markup.
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>window.__pwned");
    expect(html).not.toContain("<svg onload");

    // And nothing actually executed in the print document.
    const pwned = await popup.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    );
    expect(pwned).toBeUndefined();
  });
});
