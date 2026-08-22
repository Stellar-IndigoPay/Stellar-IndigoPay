"use strict";

const request = require("supertest");
const crypto = require("crypto");
const app = require("../../server");
const pool = require("../../db/pool");
const { metrics } = require("../../services/metrics");

describe("Turrets Heartbeat API", () => {
  let activeTurretId;
  let activeApiKey;
  let revokedTurretId;
  let revokedApiKey;

  beforeAll(async () => {
    // Generate active turret
    const rawActive = crypto.randomBytes(32).toString("hex");
    activeApiKey = `ip_turret_${rawActive}`;
    const activeHash = crypto.createHash("sha256").update(activeApiKey).digest("hex");
    activeTurretId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO turrets (id, name, scope, api_key_hash) VALUES ($1, $2, $3, $4)`,
      [activeTurretId, "Test Active", "matching", activeHash]
    );

    // Generate revoked turret
    const rawRevoked = crypto.randomBytes(32).toString("hex");
    revokedApiKey = `ip_turret_${rawRevoked}`;
    const revokedHash = crypto.createHash("sha256").update(revokedApiKey).digest("hex");
    revokedTurretId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO turrets (id, name, scope, api_key_hash, status) VALUES ($1, $2, $3, $4, $5)`,
      [revokedTurretId, "Test Revoked", "matching", revokedHash, "revoked"]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM turrets WHERE id IN ($1, $2)`, [activeTurretId, revokedTurretId]);
  });

  it("returns 401 if missing X-Turret-Key", async () => {
    const res = await request(app).post("/api/turrets/heartbeat").send({});
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid api key", async () => {
    const res = await request(app)
      .post("/api/turrets/heartbeat")
      .set("X-Turret-Key", "invalid_key")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 403 for revoked api key", async () => {
    const res = await request(app)
      .post("/api/turrets/heartbeat")
      .set("X-Turret-Key", revokedApiKey)
      .send({});
    expect(res.status).toBe(403);
  });

  it("updates last_heartbeat for valid api key", async () => {
    const res = await request(app)
      .post("/api/turrets/heartbeat")
      .set("X-Turret-Key", activeApiKey)
      .send({});
    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT last_heartbeat FROM turrets WHERE id = $1`, [activeTurretId]);
    expect(rows[0].last_heartbeat).not.toBeNull();
  });
});
