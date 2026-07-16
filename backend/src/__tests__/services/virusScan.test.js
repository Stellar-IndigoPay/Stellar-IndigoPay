"use strict";

const virusScan = require("../../services/virusScan");
const clamd = require("clamdjs");
const { metrics } = require("../../services/metrics");

jest.mock("clamdjs", () => {
  return {
    createScanner: jest.fn().mockReturnValue({
      scanBuffer: jest.fn(),
    }),
  };
});

describe("virusScan service", () => {
  let scanner;

  beforeEach(() => {
    jest.clearAllMocks();
    scanner = clamd.createScanner();
    // Reset metrics
    metrics.virusScanTotal.reset();
  });

  it("should return clean true for OK result", async () => {
    scanner.scanBuffer.mockResolvedValue("stream: OK");
    const buffer = Buffer.from("clean data");
    const result = await virusScan.scanBuffer(buffer);
    
    expect(result.clean).toBe(true);
    expect(scanner.scanBuffer).toHaveBeenCalledWith(buffer, 10000, 1024 * 1024);
  });

  it("should return clean false for FOUND result", async () => {
    scanner.scanBuffer.mockResolvedValue("stream: Eicar-Test-Signature FOUND");
    const buffer = Buffer.from("bad data");
    const result = await virusScan.scanBuffer(buffer);
    
    expect(result.clean).toBe(false);
    expect(result.signature).toBe("Eicar-Test-Signature");
  });

  it("should throw AppError when clamd fails and fail open is false", async () => {
    // By default CLAMD_FAIL_OPEN is false
    scanner.scanBuffer.mockRejectedValue(new Error("Connection refused"));
    const buffer = Buffer.from("data");
    await expect(virusScan.scanBuffer(buffer)).rejects.toThrow(/Service temporarily unavailable/);
  });
});
