import { test, expect, type Page, type Route } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import { mockApi } from "./fixtures/api";

const verificationRequests = Array.from({ length: 12 }, (_, index) => {
  const statuses = ["pending", "in_review", "approved", "rejected"] as const;
  return {
    id: `queue-${index + 1}`,
    organizationName: `${String.fromCharCode(65 + index)} Org`,
    organizationCountry: "US",
    projectName: `${String.fromCharCode(90 - index)} Project`,
    projectCategory: index % 2 === 0 ? "Reforestation" : "Solar",
    co2PerXLM: 100 + index,
    status: statuses[index % statuses.length],
    submittedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    reviewedAt: statuses[index % statuses.length] === "approved" ? new Date().toISOString() : null,
  };
});

async function mockVerificationQueue(page: Page) {
  await page.route("**/api/v1/verification-requests*", async (route: Route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") || 10);
    const currentPage = Number(url.searchParams.get("page") || 1);
    const status = url.searchParams.get("status");
    const filtered = status
      ? verificationRequests.filter((request) => request.status === status)
      : verificationRequests;
    const start = (currentPage - 1) * limit;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: filtered.slice(start, start + limit) }),
    });
  });
}

test("admin verification queue supports sort, filter, pagination, and CSV export", async ({ page }) => {
  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);
  await mockVerificationQueue(page);

  await page.goto("/admin/verification", { timeout: 60000 });
  await expect(page.getByRole("heading", { name: "Verification Queue" })).toBeVisible();

  await expect(page.getByRole("row").filter({ hasText: "A Org" })).toBeVisible();
  await expect(page.getByText("Showing 1-10 of 12")).toBeVisible();

  await page.getByRole("button", { name: "Sort by Organization" }).click();
  const firstDataRow = page.locator("tbody tr").first();
  await expect(firstDataRow).toContainText("A Org");
  await page.getByRole("button", { name: "Sort by Organization" }).click();
  await expect(firstDataRow).toContainText("J Org");

  await page.getByRole("button", { name: "Pending" }).click();
  await expect(page.getByText("Showing 1-3 of 3")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "A Org" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "B Org" })).toHaveCount(0);

  await page.getByRole("button", { name: "All" }).click();
  await expect(page.getByText("Showing 1-10 of 12")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 11-12 of 12")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "K Org" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("verification-queue-all.csv");
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream!.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream!.on("end", resolve);
    stream!.on("error", reject);
  });
  expect(Buffer.concat(chunks).toString("utf8")).toContain("Organization,Project,Category,Status");
});
