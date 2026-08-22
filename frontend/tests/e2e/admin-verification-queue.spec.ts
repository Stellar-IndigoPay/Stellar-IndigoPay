import { expect, test, type Page, type Route } from "@playwright/test";

const requests = Array.from({ length: 12 }, (_, index) => {
  const id = index + 1;
  const statuses = ["pending", "in_review", "approved", "rejected"] as const;
  return {
    id: `req-${id}`,
    projectId: `project-${id}`,
    organizationName: [
      "Zulu Climate Trust",
      "Alpha Solar Coop",
      "Mango Forest Alliance",
      "Beacon Ocean Fund",
      "Cedar Wind Group",
      "Delta Soil Lab",
      "Evergreen Biochar",
      "Fjord Tidal Works",
      "Golden Mangroves",
      "Harbor Reef Team",
      "Ivory Prairie Org",
      "Juniper Wetlands",
    ][index],
    organizationCountry: ["Kenya", "Peru", "Brazil", "Fiji"][index % 4],
    contactEmail: `admin-${id}@example.org`,
    projectName: `Verification Project ${String(id).padStart(2, "0")}`,
    projectCategory: ["Reforestation", "Solar Energy", "Blue Carbon", "Biochar"][index % 4],
    co2PerXLM: 10 + id,
    walletAddress: `G${String(id).padStart(55, "A")}`,
    status: statuses[index % statuses.length],
    submittedAt: `2026-08-${String(15 - index).padStart(2, "0")}T12:00:00Z`,
    reviewedAt: statuses[index % statuses.length] === "approved" ? "2026-08-15T12:00:00Z" : null,
    reviewedBy: statuses[index % statuses.length] === "approved" ? "admin" : null,
    reviewNotes: null,
    documents: [],
    createdAt: `2026-08-${String(15 - index).padStart(2, "0")}T12:00:00Z`,
    updatedAt: `2026-08-${String(15 - index).padStart(2, "0")}T12:00:00Z`,
  };
});

async function mockAdminVerificationApi(page: Page) {
  await page.route("**/api/v1/admin/login*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { token: "mock-admin-token", expiresIn: 3600 } }),
    });
  });

  await page.route("**/api/v1/admin/refresh*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { token: "mock-admin-token", expiresIn: 3600 } }),
    });
  });

  await page.route("**/api/v1/verification-requests*", async (route: Route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "10");
    const status = url.searchParams.get("status");
    const filtered = status ? requests.filter((request) => request.status === status) : requests;
    const data = url.searchParams.has("page")
      ? filtered.slice((pageNumber - 1) * limit, pageNumber * limit)
      : filtered.slice(0, limit);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data }),
    });
  });
}

async function login(page: Page) {
  await page.goto("/admin/login", { timeout: 60_000 });
  await page.fill("#username", "admin");
  await page.fill("#password", "adminpass");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/verification/);
  await expect(page.getByRole("heading", { name: "Verification Queue" })).toBeVisible();
}

test.describe("admin verification queue", () => {
  test("sorts, filters, paginates, and exports CSV", async ({ page }) => {
    await mockAdminVerificationApi(page);
    await login(page);

    const firstBodyRow = page.locator("tbody tr").first();
    await expect(firstBodyRow).toContainText("Zulu Climate Trust");

    await page.getByRole("button", { name: "Sort by Organization" }).click();
    await expect(firstBodyRow).toContainText("Alpha Solar Coop");

    await page.getByRole("button", { name: "Pending" }).click();
    await expect(page.getByText("Showing 1-3 of 3")).toBeVisible();
    await expect(page.locator("tbody")).toContainText("Zulu Climate Trust");
    await expect(page.locator("tbody")).not.toContainText("Alpha Solar Coop");

    await page.getByRole("button", { name: "All" }).click();
    await expect(page.getByText("Showing 1-10 of 12")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Showing 11-12 of 12")).toBeVisible();
    await expect(page.locator("tbody")).toContainText("Ivory Prairie Org");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export verification queue as CSV" }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");

    expect(download.suggestedFilename()).toMatch(/^verification-queue-all-\d+\.csv$/);
    expect(csv).toContain('"Organization","Project","Category","CO2 per XLM","Status","Submitted"');
    expect(csv).toContain('"Zulu Climate Trust"');
    expect(csv.split("\n").length).toBeGreaterThan(1);
  });
});
