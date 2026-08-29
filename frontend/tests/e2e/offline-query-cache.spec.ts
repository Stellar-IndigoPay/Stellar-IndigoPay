import { test, expect } from "@playwright/test";
import { mockApi, MOCK_PROJECT } from "./fixtures/api";

test("keeps cached projects offline and refetches after reconnect", async ({
  page,
  context,
}) => {
  await mockApi(page);
  await page.goto("/projects");
  await expect(page.getByText(MOCK_PROJECT.name).first()).toBeVisible();

  // Make the cached query stale without waiting for the real clock.
  await page.clock.install({ time: new Date() });
  await page.clock.fastForward(31_000);

  let projectRefetches = 0;
  await page.route(/\/api\/v1\/projects(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("facets") === "true") {
      await route.fallback();
      return;
    }

    projectRefetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: [{ ...MOCK_PROJECT, name: "Reconnected project" }],
      }),
    });
  });

  await context.setOffline(true);
  await expect(page.getByText(MOCK_PROJECT.name).first()).toBeVisible();

  const refetch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/api/v1/projects" &&
      url.searchParams.get("facets") !== "true"
    );
  });
  await context.setOffline(false);
  await refetch;

  await expect(page.getByText("Reconnected project").first()).toBeVisible();
  expect(projectRefetches).toBe(1);
});
