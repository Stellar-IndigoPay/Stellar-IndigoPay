"use strict";

/**
 * services/digestBuilder.test.js
 *
 * Digest construction with project-update suppression (issue #935).
 *
 * The digest's updates query only ever selects `live` updates (the SQL
 * filter), and the builder additionally drops any non-live row that slips
 * through — so a removed or quarantined update can never reach a recipient's
 * digest, and the daily/weekly digest stays aligned with the moderated feed.
 */

jest.mock("../db/pool", () => ({ query: jest.fn() }));

process.env.JWT_SECRET = "test-secret";

const pool = require("../db/pool");
const { buildDigests } = require("./digestBuilder");

const NOW = new Date("2026-08-10T13:00:00.000Z");
const START = "2026-08-09T00:00:00.000Z";
const END = "2026-08-10T00:00:00.000Z";

function summaryRow() {
  return {
    donor_address: "GDONOR1",
    email: "donor1@example.com",
    total_donated_xlm: "10.0000000",
    donation_count: 1,
    projects_supported: 2,
    total_co2_kg: "1.5000",
    project_names: ["Mangrove Restoration", "Reforest Now"],
  };
}

function updateRow({ id, title, status }) {
  return {
    donor_address: "GDONOR1",
    id,
    title,
    body: "body text",
    moderation_status: status,
    created_at: "2026-08-09T10:00:00.000Z",
    project_name: "Mangrove Restoration",
  };
}

function setUpdatesQuery(rows) {
  pool.query
    .mockResolvedValueOnce({ rows: [summaryRow()] }) // recipient summary
    .mockResolvedValueOnce({ rows: [] }) // recent donations
    .mockResolvedValueOnce({ rows }); // recent updates
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildDigests", () => {
  test("includes only live updates in a recipient's digest", async () => {
    setUpdatesQuery([
      updateRow({ id: "u-live", title: "Trees planted", status: "live" }),
      updateRow({ id: "u-removed", title: "Takedown", status: "removed" }),
      updateRow({ id: "u-quarantined", title: "Scam", status: "quarantined" }),
    ]);

    const { digests } = await buildDigests("daily", NOW);

    expect(digests).toHaveLength(1);
    expect(digests[0].recentUpdates).toEqual([
      expect.objectContaining({ id: "u-live", title: "Trees planted" }),
    ]);
    // Suppressed content stays out of the digest entirely.
    expect(
      digests[0].recentUpdates.some((u) => u.id === "u-removed"),
    ).toBe(false);
    expect(
      digests[0].recentUpdates.some((u) => u.id === "u-quarantined"),
    ).toBe(false);
  });

  test("the updates query filters on moderation_status = 'live'", async () => {
    setUpdatesQuery([updateRow({ id: "u-live", title: "T", status: "live" })]);

    await buildDigests("daily", NOW);

    const updatesCall = pool.query.mock.calls[2];
    expect(updatesCall[0]).toContain("pu.moderation_status = 'live'");
    expect(updatesCall[1]).toEqual([START, END, ["GDONOR1"]]);
  });

  test("builds a digest with no updates for recipients of quiet projects", async () => {
    setUpdatesQuery([]);

    const { digests } = await buildDigests("daily", NOW);

    expect(digests[0].recentUpdates).toEqual([]);
    expect(digests[0].recentDonations).toEqual([]);
    expect(digests[0].unsubscribeToken).toEqual(expect.any(String));
  });

  test("does not run the updates query when there are no recipients", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await buildDigests("daily", NOW);

    expect(result.digests).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});