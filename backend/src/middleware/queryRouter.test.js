"use strict";

jest.mock("../db/pool", () => ({
  getReader: jest.fn(() => ({ role: "reader" })),
  getWriter: jest.fn(() => ({ role: "writer" })),
  runWithQueryRole: jest.fn((_method, callback) => callback()),
}));

const queryRouter = require("./queryRouter");
const pool = require("../db/pool");

function run(method) {
  const req = { method };
  const next = jest.fn();
  queryRouter(req, {}, next);
  return { req, next };
}

describe("queryRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sets reader client for read-only methods", () => {
    const { req, next } = run("GET");

    expect(req.getClient()).toEqual({ role: "reader" });
    expect(req.getReader()).toEqual({ role: "reader" });
    expect(req.getWriter()).toEqual({ role: "writer" });
    expect(pool.runWithQueryRole).toHaveBeenCalledWith("GET", next);
  });

  test("sets writer client for mutation methods", () => {
    const { req, next } = run("POST");

    expect(req.getClient()).toEqual({ role: "writer" });
    expect(pool.runWithQueryRole).toHaveBeenCalledWith("POST", next);
  });
});
