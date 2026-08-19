const { setTimeout, clearTimeout, setInterval, clearInterval } = require('timers');
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.setInterval = setInterval;
global.clearInterval = clearInterval;
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;
globalThis.setInterval = setInterval;
globalThis.clearInterval = clearInterval;

// ── JWT secret for tests ──────────────────────────────────────────────────
// auth.js getSecret() requires JWT_SECRET to be set. Tests that exercise
// JWT token generation or verification must have a known secret available.
// We use TEST_JWT_SECRET (the non-production escape hatch in getSecret())
// so tests never accidentally run with a real production secret.
// If a test file sets JWT_SECRET explicitly, that takes precedence.
if (!process.env.JWT_SECRET && !process.env.TEST_JWT_SECRET) {
  process.env.TEST_JWT_SECRET = 'test-only-jwt-secret-do-not-use-in-production';
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
