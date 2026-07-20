"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("./email", () => ({
  sendOnboardingEmail: jest.fn().mockResolvedValue({ success: true }),
}));

const pool = require("../db/pool");
const { onboardProject, buildOnboardingChecklist } = require("./onboardingService");
const { sendOnboardingEmail } = require("./email");

describe("onboardingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("onboardProject inserts project and onboarding data, then sends email", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const verificationRequest = {
      id: "req-123",
      projectName: "Test Project",
      projectDescription: "A sample project.",
      projectCategory: "Solar Energy",
      projectLocation: "Nairobi, Kenya",
      walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      contactEmail: "owner@example.com",
    };

    const result = await onboardProject(verificationRequest);

    expect(result).toHaveProperty("projectId");
    expect(result).toHaveProperty("webhookSecret");
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(sendOnboardingEmail).toHaveBeenCalledTimes(1);
    expect(sendOnboardingEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: verificationRequest.contactEmail,
      projectName: verificationRequest.projectName,
      projectId: result.projectId,
    }));
  });

  test("buildOnboardingChecklist returns the expected checklist keys", () => {
    const checklist = buildOnboardingChecklist();
    expect(checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "verify_wallet" }),
        expect.objectContaining({ key: "configure_webhook" }),
      ]),
    );
  });
});
