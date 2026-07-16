"use strict";

/**
 * Tests for scripts/verify-backup.js
 *
 * Uses Jest mocks to avoid needing Docker during unit testing.
 * Each test isolates fs, child_process, and crypto to simulate
 * backup verification scenarios.
 */

const fs = require("fs");
const crypto = require("crypto");
const childProcess = require("child_process");

// We must require the module AFTER setting up mocks because the module
// references these at require-time.
jest.mock("fs");
jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return {
    ...actual,
    createHash: jest.fn(() => actual.createHash("sha256")),
  };
});
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execSync: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
});

// zlib is used by gunzipFile internally
jest.mock("zlib", () => {
  const actual = jest.requireActual("zlib");
  return {
    ...actual,
    gunzipSync: jest.fn((buf) => buf),
  };
});

const { verifyBackup, CRITICAL_TABLES, MIN_ROW_COUNTS } = require("../../scripts/verify-backup");

describe("verifyBackup", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: simulate a valid 2 MB SQL file
    fs.statSync.mockReturnValue({ size: 2 * 1024 * 1024 });
    fs.readFileSync.mockReturnValue(Buffer.from("-- mock SQL dump\nCREATE TABLE projects(id UUID);"));
    fs.existsSync.mockReturnValue(true);

    // Reset spawnSync to default success
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    // execSync: by default succeed for docker commands and psql queries
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready")) return "ready";
      if (cmdStr.includes("SELECT EXISTS") && cmdStr.includes("information_schema.tables"))
        return "t";
      // FK check must come before row count checks to avoid ambiguity
      if (cmdStr.includes("LEFT JOIN projects"))
        return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM projects"))
        return "12";
      if (cmdStr.includes("SELECT COUNT(*) FROM donations"))
        return "45";
      if (cmdStr.includes("SELECT COUNT(*) FROM profiles"))
        return "8";
      return "";
    });
  });

  // -----------------------------------------------------------------------
  // File Integrity
  // -----------------------------------------------------------------------

  test("passes file_exists check when file has non-zero size", () => {
    const report = verifyBackup("/backups/test.sql");
    const check = report.checks.find((c) => c.name === "file_exists");
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("MB");
  });

  test("fails file_exists when file size is zero", () => {
    fs.statSync.mockReturnValue({ size: 0 });
    const report = verifyBackup("/backups/empty.sql");
    expect(report.passed).toBe(false);
    expect(report.error).toContain("Empty backup file");
    const check = report.checks.find((c) => c.name === "file_exists");
    expect(check.passed).toBe(false);
  });

  test("fails when file is not found (fs.statSync throws)", () => {
    fs.statSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    const report = verifyBackup("/backups/missing.sql");
    expect(report.passed).toBe(false);
    expect(report.error).toContain("Backup file not found");
  });

  // -----------------------------------------------------------------------
  // Checksum
  // -----------------------------------------------------------------------

  test("computes SHA-256 checksum of the backup file", () => {
    const report = verifyBackup("/backups/test.sql");
    const check = report.checks.find((c) => c.name === "checksum");
    expect(check.passed).toBe(true);
    expect(check.detail).toBeTruthy();
    expect(report.checksum).toBe(check.detail);
  });

  // -----------------------------------------------------------------------
  // Docker Container Lifecycle
  // -----------------------------------------------------------------------

  test("attempts to remove existing container before starting a new one", () => {
    verifyBackup("/backups/test.sql");
    const calls = childProcess.execSync.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : c[0].toString()))
      .join(" ");
    expect(calls).toContain("docker rm -f verify-pg");
    expect(calls).toContain("docker run -d --name verify-pg");
  });

  test("cleans up temp container even when verification fails", () => {
    // Simulate a good file, but make spawnSync restore fail
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "Restore failed" });
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready -q && echo")) return "ready";
      if (cmdStr.includes("docker rm -f verify-pg")) return "";
      if (cmdStr.includes("docker run -d")) return "abc123";
      return "";
    });

    const report = verifyBackup("/backups/test.sql");
    // Check that docker rm was called at least once
    const rmCalls = childProcess.execSync.mock.calls.filter((c) => {
      const s = typeof c[0] === "string" ? c[0] : c[0].toString();
      return s.includes("docker rm -f verify-pg");
    });
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(report.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Table Existence Checks
  // -----------------------------------------------------------------------

  test.each(CRITICAL_TABLES)(
    "reports table_%s_exists as passed when table exists",
    (table) => {
      const report = verifyBackup("/backups/test.sql");
      const check = report.checks.find((c) => c.name === `table_${table}_exists`);
      expect(check).toBeDefined();
      expect(check.passed).toBe(true);
    }
  );

  test("reports table existence as failed when table is missing", () => {
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready")) return "ready";
      if (cmdStr.includes("information_schema.tables WHERE table_name")) return "f";
      if (cmdStr.includes("LEFT JOIN projects")) return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM projects")) return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM donations")) return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM profiles")) return "0";
      return "";
    });

    const report = verifyBackup("/backups/test.sql");
    const checks = report.checks.filter((c) => c.name.startsWith("table_") && c.name.endsWith("_exists"));
    expect(checks.length).toBe(CRITICAL_TABLES.length);
    expect(checks.every((c) => c.passed === false)).toBe(true);
    expect(report.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Row Count Assertions
  // -----------------------------------------------------------------------

  test.each(Object.entries(MIN_ROW_COUNTS))(
    "validates row count for %s (min: %i)",
    (table, minCount) => {
      const report = verifyBackup("/backups/test.sql");
      const check = report.checks.find(
        (c) => c.name === `table_${table}_row_count`
      );
      expect(check).toBeDefined();
      expect(check.passed).toBe(true);
      expect(check.detail).toMatch(/\d+ rows/);
    }
  );

  test("fails row count when table has fewer rows than minimum", () => {
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready")) return "ready";
      if (cmdStr.includes("information_schema.tables")) return "t";
      if (cmdStr.includes("LEFT JOIN projects")) return "0";
      // Only projects has a min of 1; return 0 for it
      if (cmdStr.includes("SELECT COUNT(*) FROM projects")) return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM donations")) return "5";
      if (cmdStr.includes("SELECT COUNT(*) FROM profiles")) return "3";
      return "";
    });

    const report = verifyBackup("/backups/test.sql");
    const check = report.checks.find((c) => c.name === "table_projects_row_count");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("0 rows");
    expect(report.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Foreign Key Consistency
  // -----------------------------------------------------------------------

  test("passes FK check when there are zero orphaned donations", () => {
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready")) return "ready";
      if (cmdStr.includes("information_schema.tables")) return "t";
      // FK check must match before row count checks
      if (cmdStr.includes("LEFT JOIN projects")) return "0";
      if (cmdStr.includes("SELECT COUNT(*) FROM projects")) return "5";
      if (cmdStr.includes("SELECT COUNT(*) FROM donations")) return "10";
      if (cmdStr.includes("SELECT COUNT(*) FROM profiles")) return "3";
      return "";
    });

    const report = verifyBackup("/backups/test.sql");
    const check = report.checks.find(
      (c) => c.name === "foreign_key_donations_projects"
    );
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("0 orphaned");
  });

  test("fails FK check when orphaned donations exist", () => {
    childProcess.execSync.mockImplementation((cmd) => {
      const cmdStr = typeof cmd === "string" ? cmd : cmd.toString();
      if (cmdStr.includes("pg_isready")) return "ready";
      if (cmdStr.includes("information_schema.tables")) return "t";
      // FK check must match before row count checks
      if (cmdStr.includes("LEFT JOIN projects")) return "3";
      if (cmdStr.includes("SELECT COUNT(*) FROM projects")) return "5";
      if (cmdStr.includes("SELECT COUNT(*) FROM donations")) return "10";
      if (cmdStr.includes("SELECT COUNT(*) FROM profiles")) return "3";
      return "";
    });

    const report = verifyBackup("/backups/test.sql");
    const check = report.checks.find(
      (c) => c.name === "foreign_key_donations_projects"
    );
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("3 orphaned");
    expect(report.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Report Structure
  // -----------------------------------------------------------------------

  test("report includes timestamp in ISO-8601 format", () => {
    const report = verifyBackup("/backups/test.sql");
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("report includes backup path", () => {
    const report = verifyBackup("/backups/test.sql");
    expect(report.backup).toBe("/backups/test.sql");
  });

  test("report includes duration in milliseconds", () => {
    const report = verifyBackup("/backups/test.sql");
    expect(typeof report.durationMs).toBe("number");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("all checks pass yields passed: true", () => {
    const report = verifyBackup("/backups/test.sql");
    expect(report.passed).toBe(true);
  });

  test("a single failing check yields passed: false", () => {
    fs.statSync.mockReturnValue({ size: 0 });
    const report = verifyBackup("/backups/test.sql");
    expect(report.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Gzipped backup
  // -----------------------------------------------------------------------

  test("handles .gz backup files by decompressing before restore", () => {
    const zlib = require("zlib");
    zlib.gunzipSync.mockReturnValue(Buffer.from("-- decompressed SQL"));

    const report = verifyBackup("/backups/test.sql.gz");
    expect(report.passed).toBe(true);
    expect(zlib.gunzipSync).toHaveBeenCalled();
  });
});
