import type { Page, Route } from "@playwright/test";

export const MOCK_PROJECT = {
  id: "e4aa582a-e87f-4fef-9a5c-55c32918bb12",
  name: "Amazon Reforestation",
  category: "Reforestation",
  description: "Planting trees in the Amazon rainforest.",
  location: "Brazil",
  goalXLM: "10000",
  raisedXLM: "5000",
  donorCount: 10,
  co2OffsetKg: 60000,
  walletAddress: "GBWARNKVFUYBSD6ZBJRLKXFWOZRXB5TIICONCHYQNYFF2J2IRQM4R2KR",
  organization: {
    name: "Save The Trees",
    contactEmail: "info@savethetrees.org",
    website: "https://savethetrees.org",
    country: "Brazil"
  },
  co2Methodology: {
    name: "Gold Standard",
    annualTonnesCO2: "1200",
    verificationBody: "Verra",
    documentUrl: "https://verra.org/doc"
  },
  impactMetrics: ["Trees planted: 5000", "CO2 offset: 1200t"],
  tags: ["reforestation", "carbon-offset"],
  createdAt: "2026-07-17T12:00:00Z",
  updatedAt: "2026-07-17T12:00:00Z",
  verified: true,
  status: "active"
};

export const MOCK_PROFILE = {
  publicKey: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
  displayName: "Test Donor",
  bio: "Supporting global reforestation efforts",
  totalDonatedXLM: "500",
  projectsSupported: 1,
  badges: [
    { tier: "Seedling", earnedAt: "2026-07-16T12:00:00Z" }
  ]
};

export const MOCK_DONATION = {
  id: "don-1",
  projectId: "e4aa582a-e87f-4fef-9a5c-55c32918bb12",
  donorAddress: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
  amountXLM: "50",
  currency: "XLM",
  message: "Keep up the great work!",
  transactionHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  createdAt: "2026-07-17T12:00:00Z"
};

export const MOCK_ANALYTICS = {
  trends: [
    { day: "2026-07-17", donationCount: 1, totalXLM: "50", uniqueDonors: 1, avgDonationXLM: "50" }
  ],
  projects: [
    {
      id: "e4aa582a-e87f-4fef-9a5c-55c32918bb12",
      name: "Amazon Reforestation",
      category: "Reforestation",
      location: "Brazil",
      raisedXLM: "5000",
      donorCount: 10,
      goalXLM: "10000",
      co2OffsetKg: 60000,
      status: "active",
      verified: true,
      progressPct: 50,
      totalDonations: 10,
      lastDonationAt: "2026-07-17T12:00:00Z",
      createdAt: "2026-07-10T12:00:00Z"
    }
  ],
  geographic: [
    { country: "Brazil", projectCount: 1, totalXLM: "5000", donorCount: 10, totalCO2Kg: 60000 }
  ],
  retention: [
    { cohortMonth: "2026-07", cohortSize: 10, activityMonth: "2026-07", activeDonors: 8, retentionPct: 80 }
  ],
  categories: [
    { category: "Reforestation", donationCount: 10, totalXLM: "5000", donorCount: 10 }
  ],
  growth: {
    summary: {
      totalProjects: 1,
      totalDonations: 10,
      totalDonors: 5,
      totalXLM: "5000",
      activeDonors30d: 4,
      totalXLM30d: "3000"
    },
    monthlyGrowth: [
      { month: "2026-07", donations: 10, "totalXLM": "5000", donors: 5 }
    ]
  }
};

/**
 * Mock Backend API responses using Playwright route interception.
 */
export async function mockApi(page: Page) {
  // Global CORS preflight handler
  await page.route("**/api/v1/**", (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token, X-Admin-Key, Idempotency-Key",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }
    return route.fallback();
  });

  // CSRF token endpoint
  await page.route("**/api/v1/csrf-token*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, csrfToken: "mock-csrf-token" }),
    });
  });

  // Projects list
  await page.route(/\/api\/v1\/projects(\?|$)/, (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [MOCK_PROJECT] }),
    });
  });

  // Single project detail
  await page.route("**/api/v1/projects/*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_PROJECT }),
    });
  });

  // Featured project (registered after single project detail so it takes precedence)
  await page.route("**/api/v1/projects/featured*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_PROJECT }),
    });
  });

  // Project updates
  await page.route("**/api/v1/updates/*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // Project matches
  await page.route("**/api/v1/projects/*/matching*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // Profile lookup
  await page.route("**/api/v1/profiles/*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_PROFILE }),
    });
  });

  // Donor history
  await page.route("**/api/v1/donations/donor/*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [MOCK_DONATION] }),
    });
  });

  // Record donation
  await page.route("**/api/v1/donations*", (route: Route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: MOCK_DONATION }),
      });
    }
    return route.fallback();
  });

  // Admin login
  await page.route("**/api/v1/admin/login*", (route: Route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { token: "mock-admin-token", expiresIn: 3600 }
        }),
      });
    }
    return route.fallback();
  });

  // Admin refresh session
  await page.route("**/api/v1/admin/refresh*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { token: "mock-admin-token", expiresIn: 3600 }
      }),
    });
  });

  // Admin verification list (redirect target)
  await page.route("**/api/v1/verification-requests*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // Admin queues list
  await page.route("**/api/v1/admin/queues*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // Admin Analytics endpoints
  await page.route("**/api/v1/admin/analytics/trends*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.trends }),
    });
  });

  await page.route("**/api/v1/admin/analytics/projects*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.projects }),
    });
  });

  await page.route("**/api/v1/admin/analytics/geographic*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.geographic }),
    });
  });

  await page.route("**/api/v1/admin/analytics/retention*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.retention }),
    });
  });

  await page.route("**/api/v1/admin/analytics/categories*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.categories }),
    });
  });

  await page.route("**/api/v1/admin/analytics/growth*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: MOCK_ANALYTICS.growth }),
    });
  });

  // Global platform stats
  await page.route("**/api/v1/stats/global*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          totalXLMRaised: "15000",
          totalCO2OffsetKg: 180000,
          totalDonations: 300,
          totalProjects: 5,
          totalDonors: 120
        }
      }),
    });
  });

  // Category stats
  await page.route("**/api/v1/stats/categories*", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: [
          { category: "Reforestation", count: 3 },
          { category: "Solar Energy", count: 2 }
        ]
      }),
    });
  });
}
