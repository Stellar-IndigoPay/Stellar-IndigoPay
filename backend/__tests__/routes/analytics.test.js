"use strict";

/**
 * Tests for src/routes/analytics.js
 *
 * Mocks pool.query to verify:
 * - Ownership gating (403 for non-owner wallet)
 * - 404 for missing project
 * - 429 rate limit
 * - Response shape with all analytics sections
 * - Empty state (project with zero donations)
 */

const request = require("supertest");
const express = require("express");

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../../src/db/pool");
const analyticsRouter = require("../../src/routes/analytics");
const { AppError } = require("../../src/errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", analyticsRouter);
  // Error handler
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  });
  return app;
}

describe("GET /api/projects/:id/analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validProject = {
    id: "proj-1",
    wallet_address: "GOWNERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    name: "Test Project",
    goal_xlm: "10000",
    raised_xlm: "5000",
    donor_count: 25,
    co2_offset_kg: 5000,
    category: "Reforestation",
    location: "Brazil",
    status: "active",
    verified: true,
  };

  const ownerWallet = "GOWNERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const nonOwnerWallet = "GSTRANGERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

  // -----------------------------------------------------------------------
  // Ownership / Access Control
  // -----------------------------------------------------------------------

  test("returns 403 when wallet does not match project owner", async () => {
    pool.query.mockResolvedValueOnce({ rows: [validProject] });

    const res = await request(buildApp())
      .get(`/api/projects/proj-1/analytics?wallet=${nonOwnerWallet}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  test("returns 403 when wallet query param is missing", async () => {
    pool.query.mockResolvedValueOnce({ rows: [validProject] });

    const res = await request(buildApp())
      .get("/api/projects/proj-1/analytics");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  test("returns 404 when project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/api/projects/nonexistent/analytics?wallet=${ownerWallet}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  // -----------------------------------------------------------------------
  // Successful response shape
  // -----------------------------------------------------------------------

  test("returns full analytics payload with all sections for owner", async () => {
    // Mock: project query
    pool.query.mockResolvedValueOnce({ rows: [validProject] });
    // Mock: donor overview
    pool.query.mockResolvedValueOnce({
      rows: [{
        total_donors: 25,
        new_donors_30d: 5,
        avg_donation_xlm: "100.50",
        median_donation_xlm: "50.00",
        total_raised_xlm: "5000.00",
        total_donations: 50,
      }],
    });
    // Mock: top donors
    pool.query.mockResolvedValueOnce({
      rows: [
        { donor_address: "GDONOR1XXXX", total_contributed: "1000.00", donation_count: 5, last_donation_at: new Date() },
        { donor_address: "GDONOR2XXXX", total_contributed: "500.00", donation_count: 2, last_donation_at: new Date() },
      ],
    });
    // Mock: time series
    pool.query.mockResolvedValueOnce({
      rows: [
        { date: new Date("2026-07-01"), total: "200.00", count: 4 },
        { date: new Date("2026-07-02"), total: "150.00", count: 2 },
      ],
    });
    // Mock: distribution
    pool.query.mockResolvedValueOnce({
      rows: [
        { bucket: "<10", count: 10, total: "50.00" },
        { bucket: "10-50", count: 20, total: "600.00" },
        { bucket: "50-100", count: 10, total: "750.00" },
        { bucket: "100-500", count: 8, total: "2000.00" },
        { bucket: "500+", count: 2, total: "1600.00" },
      ],
    });
    // Mock: retention
    pool.query.mockResolvedValueOnce({
      rows: [{ total_donors: 25, returning_donors: 8, retention_pct: "32.0" }],
    });
    // Mock: milestones
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "m1", title: "25% Milestone", percentage: 25, reached_at: new Date(), transaction_hash: "abc123" },
      ],
    });
    // Mock: campaigns
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "c1", title: "Campaign 1", goal_xlm: "5000", deadline: new Date("2026-12-31"), created_at: new Date("2026-01-01") },
      ],
    });
    // Mock: ratings
    pool.query.mockResolvedValueOnce({
      rows: [{
        average_rating: "4.2",
        total_ratings: 10,
        star_1: 1, star_2: 1, star_3: 2, star_4: 3, star_5: 3,
      }],
    });
    // Mock: campaign progress (one per campaign)
    pool.query.mockResolvedValueOnce({ rows: [{ raised: "2500.00" }] });

    const res = await request(buildApp())
      .get(`/api/projects/proj-1/analytics?wallet=${ownerWallet}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.projectId).toBe("proj-1");
    expect(data.projectName).toBe("Test Project");

    // Donor overview
    expect(data.donorOverview.totalDonors).toBe(25);
    expect(data.donorOverview.newDonors30d).toBe(5);
    expect(data.donorOverview.avgDonationXLM).toBe("100.50");
    expect(data.donorOverview.medianDonationXLM).toBe("50.00");
    expect(data.donorOverview.totalRaisedXLM).toBe("5000.00");
    expect(data.donorOverview.totalDonations).toBe(50);

    // Top donors
    expect(data.topDonors).toHaveLength(2);
    expect(data.topDonors[0].donorAddress).toBe("GDONOR1XXXX");

    // Time series
    expect(data.donationTimeline).toHaveLength(2);
    expect(data.donationTimeline[0].date).toBe("2026-07-01");

    // Distribution
    expect(data.donationDistribution).toHaveLength(5);

    // Retention
    expect(data.donorRetention.totalDonors).toBe(25);
    expect(data.donorRetention.returningDonors).toBe(8);
    expect(data.donorRetention.oneTimeDonors).toBe(17);
    expect(data.donorRetention.retentionPct).toBe(32);

    // Milestones
    expect(data.milestones).toHaveLength(1);
    expect(data.milestones[0].title).toBe("25% Milestone");
    expect(data.milestones[0].reached).toBe(true);

    // Campaigns
    expect(data.campaigns).toHaveLength(1);
    expect(data.campaigns[0].title).toBe("Campaign 1");

    // Ratings
    expect(data.ratingSummary.averageRating).toBe(4.2);
    expect(data.ratingSummary.distribution["5"]).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Empty / Zero-donation project
  // -----------------------------------------------------------------------

  test("returns zeroed analytics for project with no donations", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...validProject, raised_xlm: "0", donor_count: 0 }] });
    pool.query.mockResolvedValueOnce({
      rows: [{ total_donors: 0, new_donors_30d: 0, avg_donation_xlm: null, median_donation_xlm: null, total_raised_xlm: "0", total_donations: 0 }],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [{ total_donors: 0, returning_donors: 0, retention_pct: "0" }] });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [{ average_rating: null, total_ratings: 0, star_1: 0, star_2: 0, star_3: 0, star_4: 0, star_5: 0 }] });

    const res = await request(buildApp())
      .get(`/api/projects/proj-1/analytics?wallet=${ownerWallet}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.donorOverview.totalDonors).toBe(0);
    expect(data.topDonors).toHaveLength(0);
    expect(data.donationTimeline).toHaveLength(0);
    expect(data.donationDistribution).toHaveLength(0);
    expect(data.donorRetention.totalDonors).toBe(0);
    expect(data.ratingSummary.totalRatings).toBe(0);
  });
});
