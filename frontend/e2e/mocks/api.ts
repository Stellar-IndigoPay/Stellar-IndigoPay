/**
 * e2e/mocks/api.ts — mocked IndigoPay backend.
 *
 * Intercepts every `/api/v1/**` call the frontend makes (see `lib/api.ts` —
 * all routes get rewritten from `/api/*` to `/api/v1/*` by an axios
 * interceptor) so tests never depend on a real backend being reachable.
 */
import type { Page } from "@playwright/test";
import type { ClimateProject, Donation } from "@/utils/types";

export interface MockBackendState {
  projects: ClimateProject[];
  donations: Donation[];
}

export async function mockBackendAPI(
  page: Page,
  state: MockBackendState,
): Promise<MockBackendState> {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/v1/csrf-token" && method === "GET") {
      return json({ success: true, csrfToken: "e2e-test-csrf-token" });
    }

    if (path === "/api/v1/projects/featured" && method === "GET") {
      return json({ success: true, data: state.projects[0] ?? null });
    }

    if (path === "/api/v1/projects" && method === "GET") {
      if (url.searchParams.get("facets") === "true") {
        return json({
          success: true,
          data: [],
          facets: { category: [], location: [], status: [] },
        });
      }
      const category = url.searchParams.get("category");
      const search = url.searchParams.get("search")?.toLowerCase();
      let data = state.projects;
      if (category) data = data.filter((p) => p.category === category);
      if (search)
        data = data.filter((p) =>
          p.name.toLowerCase().includes(search),
        );
      return json({ success: true, data });
    }

    const matchingMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/matching$/);
    if (matchingMatch && method === "GET") {
      return json({ success: true, data: [] });
    }

    const updatesMatch = path.match(/^\/api\/v1\/updates\/([^/]+)$/);
    if (updatesMatch && method === "GET") {
      return json({ success: true, data: [] });
    }

    const subscriberCountMatch = path.match(
      /^\/api\/v1\/subscriptions\/([^/]+)\/count$/,
    );
    if (subscriberCountMatch && method === "GET") {
      return json({ success: true, count: 0 });
    }

    const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (projectMatch && method === "GET") {
      const project = state.projects.find((p) => p.id === projectMatch[1]);
      if (!project) return json({ success: false, error: "Not found" }, 404);
      return json({ success: true, data: project });
    }

    if (path === "/api/v1/donations" && method === "POST") {
      const body = request.postDataJSON() as {
        projectId: string;
        donorAddress: string;
        amount?: string;
        amountXLM?: string;
        currency?: "XLM" | "USDC";
        message?: string;
        transactionHash: string;
      };
      const donation: Donation = {
        id: `e2e-donation-${state.donations.length + 1}`,
        projectId: body.projectId,
        donorAddress: body.donorAddress,
        amount: body.amount,
        amountXLM: body.amountXLM ?? body.amount,
        currency: body.currency ?? "XLM",
        message: body.message,
        transactionHash: body.transactionHash,
        createdAt: new Date().toISOString(),
      };
      state.donations.push(donation);

      const project = state.projects.find((p) => p.id === body.projectId);
      if (project) {
        project.raisedXLM = (
          parseFloat(project.raisedXLM) + parseFloat(donation.amountXLM || "0")
        ).toFixed(7);
        project.donorCount += 1;
      }

      return json({ success: true, data: donation });
    }

    const projectDonationsMatch = path.match(
      /^\/api\/v1\/donations\/project\/([^/]+)$/,
    );
    if (projectDonationsMatch && method === "GET") {
      const donations = state.donations.filter(
        (d) => d.projectId === projectDonationsMatch[1],
      );
      return json({ success: true, data: donations, nextCursor: null });
    }

    const donorHistoryMatch = path.match(/^\/api\/v1\/donations\/donor\/([^/]+)$/);
    if (donorHistoryMatch && method === "GET") {
      const donations = state.donations.filter(
        (d) => d.donorAddress === donorHistoryMatch[1],
      );
      return json({ success: true, data: donations });
    }

    const profileMatch = path.match(/^\/api\/v1\/profiles\/([^/]+)$/);
    if (profileMatch && method === "GET") {
      const donations = state.donations.filter(
        (d) => d.donorAddress === profileMatch[1],
      );
      const totalDonatedXLM = donations
        .reduce((sum, d) => sum + parseFloat(d.amountXLM || d.amount || "0"), 0)
        .toFixed(7);
      return json({
        success: true,
        data: {
          publicKey: profileMatch[1],
          totalDonatedXLM,
          projectsSupported: new Set(donations.map((d) => d.projectId)).size,
          badges: [],
          createdAt: new Date().toISOString(),
        },
      });
    }

    if (path === "/api/v1/ratings/pending" && method === "GET") {
      return json({ success: true, data: null });
    }

    if (path === "/api/v1/stats/global" && method === "GET") {
      return json({
        success: true,
        data: {
          totalXLMRaised: "135500.0000000",
          totalCO2OffsetKg: 24700,
          totalDonations: 402,
          totalProjects: state.projects.length,
          totalDonors: 189,
        },
      });
    }

    if (path === "/api/v1/stats/categories" && method === "GET") {
      return json({ success: true, data: [] });
    }

    if (path === "/api/v1/tags/suggestions" && method === "GET") {
      return json({ success: true, data: [] });
    }

    // Fallback: succeed with an empty payload rather than leaving the
    // request hanging, so unanticipated calls fail loudly in assertions
    // instead of timing the whole test out.
    return json({ success: true, data: [] });
  });

  return state;
}
