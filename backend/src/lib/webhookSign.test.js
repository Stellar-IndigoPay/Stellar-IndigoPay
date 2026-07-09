"use strict";

const { sign, verify, computeEventId } = require("./webhookSign");

describe("webhookSign", () => {
  const secret = "shhh";
  const body = JSON.stringify({ hello: "world" });
  const t = 1_700_000_000;

  describe("sign", () => {
    test("produces t=<unix>,v1=<hex> header", () => {
      const header = sign(body, secret, t);
      expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(header.startsWith(`t=${t},`)).toBe(true);
    });

    test("two calls with the same inputs produce the same signature", () => {
      expect(sign(body, secret, t)).toBe(sign(body, secret, t));
    });

    test("changing the body invalidates the signature", () => {
      const a = sign(body, secret, t);
      const b = sign(body + "tamper", secret, t);
      expect(a).not.toBe(b);
    });

    test("changing the secret invalidates the signature", () => {
      const a = sign(body, secret, t);
      const b = sign(body, "other-secret", t);
      expect(a).not.toBe(b);
    });
  });

  describe("verify", () => {
    test("accepts a fresh, valid signature", () => {
      const header = sign(body, secret, t);
      expect(verify(body, secret, header, t)).toBe(true);
    });

    test("rejects a signature from the future past the replay window", () => {
      const header = sign(body, secret, t);
      // 10 minutes in the future
      const future = t + 10 * 60;
      expect(verify(body, secret, header, future)).toBe(false);
    });

    test("rejects a signature from the past past the replay window", () => {
      const header = sign(body, secret, t);
      const past = t - 10 * 60;
      expect(verify(body, secret, header, past)).toBe(false);
    });

    test("rejects a signature with a tampered body", () => {
      const header = sign(body, secret, t);
      expect(verify(body + "tamper", secret, header, t)).toBe(false);
    });

    test("rejects a malformed header", () => {
      expect(verify(body, secret, "garbage", t)).toBe(false);
      expect(verify(body, secret, "t=,v1=abcd", t)).toBe(false);
      expect(verify(body, secret, "t=1700000000", t)).toBe(false);
      expect(verify(body, secret, "", t)).toBe(false);
    });

    test("rejects when v1 length differs (constant-time check)", () => {
      const header = sign(body, secret, t);
      // truncate v1
      const [tPart, v1Part] = header.split(",");
      const truncated = `${tPart},${v1Part.slice(2)}`;
      expect(verify(body, secret, truncated, t)).toBe(false);
    });
  });

  describe("computeEventId", () => {
    test("is deterministic for the same canonical fields", () => {
      const a = computeEventId({ projectId: "p1", milestoneId: "m1", percentage: 25, raisedXlm: "1.5" });
      const b = computeEventId({ projectId: "p1", milestoneId: "m1", percentage: 25, raisedXlm: "1.5" });
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    test("changes when any field changes", () => {
      const base = { projectId: "p1", milestoneId: "m1", percentage: 25, raisedXlm: "1.5" };
      expect(computeEventId(base)).not.toBe(computeEventId({ ...base, percentage: 26 }));
      expect(computeEventId(base)).not.toBe(computeEventId({ ...base, projectId: "p2" }));
      expect(computeEventId(base)).not.toBe(computeEventId({ ...base, milestoneId: "m2" }));
      expect(computeEventId(base)).not.toBe(computeEventId({ ...base, raisedXlm: "1.6" }));
    });
  });
});
