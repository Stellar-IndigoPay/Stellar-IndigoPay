"use strict";

/**
 * src/services/geocoder.js
 *
 * Resolves a free-text project location (e.g. "Amazonas, Brazil") to
 * coordinates using the Nominatim (OpenStreetMap) search API — free, no
 * API key required. Results are cached in Redis for 30 days (reuses
 * services/redis.js, which degrades gracefully when Redis is unavailable)
 * to avoid re-geocoding the same location string on every request.
 *
 * Nominatim's usage policy caps anonymous usage at 1 request/second, so
 * all outbound requests are serialized through `rateLimitedFetch`.
 */

const logger = require("../logger");
const redis = require("./redis");

const CACHE_PREFIX = "geocode:";
const CACHE_TTL_SECONDS = 86400 * 30; // 30 days
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Stellar-IndigoPay/1.0";
const MIN_REQUEST_INTERVAL_MS = 1000; // Nominatim: 1 req/sec for anonymous use

let lastRequestAt = 0;

function cacheKey(location) {
  return CACHE_PREFIX + location.toLowerCase().trim();
}

/**
 * Serialize outbound Nominatim requests to at most 1/sec.
 */
async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt));
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
  return fetch(url, { headers: { "User-Agent": USER_AGENT } });
}

/**
 * Geocode a location string to { latitude, longitude }.
 *
 * @param {string} location - Free-text location, e.g. "Kenya" or "Paris, France".
 * @returns {Promise<{latitude: number, longitude: number}|null>} Coordinates,
 *   or null if the location could not be resolved or geocoding failed.
 */
async function geocode(location) {
  if (!location || typeof location !== "string" || !location.trim()) {
    return null;
  }
  const key = cacheKey(location);

  const cached = await redis.get(key);
  if (cached) return cached;

  try {
    const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(location)}&limit=1`;
    const response = await rateLimitedFetch(url);
    if (!response.ok) {
      logger.warn(
        { event: "geocode_http_error", location, status: response.status },
        "Nominatim returned a non-OK status",
      );
      return null;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn({ event: "geocode_not_found", location }, "location could not be geocoded");
      return null;
    }

    const latitude = parseFloat(data[0].lat);
    const longitude = parseFloat(data[0].lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      logger.warn(
        { event: "geocode_invalid_response", location },
        "Nominatim response did not contain valid coordinates",
      );
      return null;
    }

    const result = { latitude, longitude };
    await redis.set(key, result, CACHE_TTL_SECONDS);
    return result;
  } catch (err) {
    logger.error({ event: "geocode_error", location, err: err.message }, "geocoding request failed");
    return null;
  }
}

module.exports = { geocode };
