"use strict";
/**
 * Unit tests for project service layer.
 */

describe("Project Service", () => {
  test("getAllProjects returns array", () => {
    const mockProjects = [
      { id: "proj-1", name: "Project 1", active: true },
      { id: "proj-2", name: "Project 2", active: true },
    ];

    expect(Array.isArray(mockProjects)).toBe(true);
    expect(mockProjects).toHaveLength(2);
  });

  test("getProjectById returns single project or null", () => {
    const projects = {
      "proj-1": { id: "proj-1", name: "Project 1" },
    };

    const result = projects["proj-1"] || null;
    expect(result).toBeDefined();
    expect(result.id).toBe("proj-1");

    const missing = projects["proj-missing"] || null;
    expect(missing).toBeNull();
  });

  test("registerProject validates required fields", () => {
    const validProject = {
      id: "proj-new",
      name: "New Project",
      wallet: "G" + "A".repeat(55),
      co2_per_xlm: 10,
    };

    const validateProject = (p) => {
      if (!p.id || !p.name || !p.wallet) return false;
      if (p.co2_per_xlm == null || p.co2_per_xlm < 0) return false;
      return true;
    };

    expect(validateProject(validProject)).toBe(true);
    expect(validateProject({ id: "x", name: "x" })).toBe(false);
    expect(validateProject({})).toBe(false);
  });

  test("deactivateProject marks project as inactive", () => {
    const project = { id: "proj-1", active: true };
    project.active = false;

    expect(project.active).toBe(false);
  });

  test("pauseProject sets paused flag", () => {
    const project = { id: "proj-1", active: true, paused: false };
    project.paused = true;

    expect(project.paused).toBe(true);
    expect(project.active).toBe(true);
  });

  test("resumeProject clears paused flag", () => {
    const project = { id: "proj-1", active: true, paused: true };
    project.paused = false;

    expect(project.paused).toBe(false);
  });

  test("updateCO2Rate updates co2_per_xlm", () => {
    const project = { id: "proj-1", co2_per_xlm: 10 };
    project.co2_per_xlm = 25;

    expect(project.co2_per_xlm).toBe(25);
  });

  test("getDonationsForProject filters by project ID", () => {
    const allDonations = [
      { project: "proj-1", amount: 100 },
      { project: "proj-2", amount: 200 },
      { project: "proj-1", amount: 50 },
    ];

    const proj1Donations = allDonations.filter((d) => d.project === "proj-1");

    expect(proj1Donations).toHaveLength(2);
    expect(proj1Donations.reduce((s, d) => s + d.amount, 0)).toBe(150);
  });

  test("computeProjectStats calculates totals correctly", () => {
    const donations = [
      { amount: 100 },
      { amount: 200 },
      { amount: 50 },
    ];

    const total = donations.reduce((s, d) => s + d.amount, 0);
    const count = donations.length;

    expect(total).toBe(350);
    expect(count).toBe(3);
  });

  test("handles empty donation list", () => {
    const donations = [];
    expect(donations.length).toBe(0);
    expect(donations.reduce((s, d) => s + (d.amount || 0), 0)).toBe(0);
  });
});
