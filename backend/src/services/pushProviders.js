"use strict";

/**
 * src/services/pushProviders.js
 *
 * Multi-provider push notification abstraction for Stellar IndigoPay.
 *
 * Provider hierarchy:
 *   iOS     → ApnsProvider  (fallback: ExpoProvider)
 *   Android → FcmProvider   (fallback: ExpoProvider)
 *   other   → ExpoProvider
 *
 * Each provider implements:
 *   send(deviceToken, payload)  → { success, providerMessageId?, unregistered?, error? }
 *   validateToken(deviceToken)  → bool
 *   providerName                → string
 *
 * Circuit breakers (module-level singletons):
 *   apns_push  — threshold 3, reset 60 s
 *   fcm_push   — threshold 3, reset 60 s
 *   expo_push  — threshold 5, reset 30 s
 *
 * Prometheus metrics (from metrics.js):
 *   indigopay_push_sent_total        {provider, outcome}
 *   indigopay_push_latency_seconds   {provider}
 */

const { Expo } = require("expo-server-sdk");
const logger = require("../logger");
const { CircuitBreaker } = require("./circuitBreaker");
const {
  metrics: { pushSentTotal, pushLatencySeconds },
} = require("./metrics");

// ---------------------------------------------------------------------------
// Lazy-loaded optional dependencies (graceful degradation when not installed)
// ---------------------------------------------------------------------------

let apn = null;
try {
  apn = require("@parse/node-apn");
} catch (e) {
  /* not installed — ApnsProvider will degrade to misconfigured state */
}

let googleAuth = null;
try {
  googleAuth = require("google-auth-library");
} catch (e) {
  /* not installed — FcmProvider will degrade */
}

// ---------------------------------------------------------------------------
// Circuit breakers (module-level singletons)
// ---------------------------------------------------------------------------

const apnsBreaker = new CircuitBreaker({
  name: "apns_push",
  failureThreshold: 3,
  resetTimeout: 60000,
});

const fcmBreaker = new CircuitBreaker({
  name: "fcm_push",
  failureThreshold: 3,
  resetTimeout: 60000,
});

const expoBreaker = new CircuitBreaker({
  name: "expo_push",
  failureThreshold: 5,
  resetTimeout: 30000,
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Record a latency observation and outcome counter for a provider.
 * @param {string} provider  'apns' | 'fcm' | 'expo'
 * @param {string} outcome   'delivered' | 'failed' | 'fallback' | 'unregistered'
 * @param {number} startMs   Date.now() value at send start
 */
function recordMetrics(provider, outcome, startMs) {
  try {
    const latency = (Date.now() - startMs) / 1000;
    pushLatencySeconds.observe({ provider }, latency);
    pushSentTotal.inc({ provider, outcome });
  } catch (e) {
    // Never let metrics errors surface to callers.
  }
}

// ---------------------------------------------------------------------------
// ApnsProvider
// ---------------------------------------------------------------------------

class ApnsProvider {
  constructor() {
    this._provider = null;
    this._configured = false;
    this._initError = null;
    this._init();
  }

  _init() {
    if (!apn) {
      this._initError = "@parse/node-apn is not installed";
      return;
    }
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const keyPath = process.env.APNS_PRIVATE_KEY_PATH;
    const bundleId = process.env.APNS_BUNDLE_ID;

    if (!keyId || !teamId || !keyPath || !bundleId) {
      this._initError =
        "APNs not configured — set APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY_PATH, APNS_BUNDLE_ID";
      logger.warn(
        { event: "apns_not_configured" },
        this._initError,
      );
      return;
    }

    try {
      this._provider = new apn.Provider({
        token: {
          key: keyPath,
          keyId,
          teamId,
        },
        production: process.env.NODE_ENV === "production",
      });
      this._bundleId = bundleId;
      this._configured = true;
      logger.info(
        { event: "apns_provider_ready", teamId, bundleId },
        "ApnsProvider initialized",
      );
    } catch (err) {
      this._initError = err.message;
      logger.error(
        { event: "apns_provider_init_failed", err: err.message },
        "Failed to initialize ApnsProvider",
      );
    }
  }

  get providerName() {
    return "apns";
  }

  /** @param {string} token */
  validateToken(token) {
    // APNs device tokens are 64-character hex strings.
    return typeof token === "string" && /^[0-9a-f]{64}$/i.test(token);
  }

  /**
   * @param {string} deviceToken
   * @param {{ title: string, body: string, data?: object, badge?: number }} payload
   * @returns {Promise<{success: boolean, providerMessageId?: string, unregistered?: boolean, error?: string}>}
   */
  async send(deviceToken, payload) {
    if (!this._configured) {
      throw new Error(this._initError || "ApnsProvider not configured");
    }

    const notification = new apn.Notification();
    notification.expiry = Math.floor(Date.now() / 1000) + 3600; // 1h TTL
    notification.badge = payload.badge ?? 1;
    notification.sound = "default";
    notification.alert = { title: payload.title, body: payload.body };
    notification.payload = payload.data || {};
    notification.topic = this._bundleId;
    notification.priority = 10; // immediate delivery

    const result = await this._provider.send(notification, deviceToken);

    if (result.sent.length > 0) {
      return {
        success: true,
        providerMessageId: result.sent[0]?.device ?? deviceToken,
      };
    }

    const failure = result.failed[0];
    const reason = failure?.response?.reason || failure?.error?.message || "unknown";

    // 410 Unregistered — device token is stale.
    if (reason === "Unregistered" || failure?.status === "410") {
      return { success: false, unregistered: true, error: reason };
    }

    throw new Error(`APNs error: ${reason}`);
  }

  /** Call once during graceful shutdown. */
  shutdown() {
    if (this._provider) this._provider.shutdown();
  }
}

// ---------------------------------------------------------------------------
// FcmProvider
// ---------------------------------------------------------------------------

const FCM_SEND_URL = "https://fcm.googleapis.com/fcm/send";

class FcmProvider {
  constructor() {
    this._serverKey = process.env.FCM_SERVER_KEY || null;
    this._configured = !!this._serverKey;

    if (!this._configured) {
      logger.warn(
        { event: "fcm_not_configured" },
        "FcmProvider: FCM_SERVER_KEY not set — FCM provider disabled",
      );
    }

    // google-auth-library is optional; fall back to FCM legacy HTTP if absent.
    this._useServiceAccount =
      googleAuth && process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  get providerName() {
    return "fcm";
  }

  /** @param {string} token */
  validateToken(token) {
    // FCM tokens are long alphanumeric strings, typically 140–200+ chars.
    return typeof token === "string" && token.length > 50;
  }

  /**
   * @param {string} deviceToken
   * @param {{ title: string, body: string, data?: object }} payload
   * @returns {Promise<{success: boolean, providerMessageId?: string, unregistered?: boolean, error?: string}>}
   */
  async send(deviceToken, payload) {
    if (!this._configured) {
      throw new Error("FcmProvider not configured — set FCM_SERVER_KEY");
    }

    const body = JSON.stringify({
      to: deviceToken,
      priority: "high",
      notification: {
        title: payload.title,
        body: payload.body,
        sound: "default",
      },
      data: payload.data || {},
    });

    const headers = {
      "Content-Type": "application/json",
      Authorization: `key=${this._serverKey}`,
    };

    const resp = await fetch(FCM_SEND_URL, {
      method: "POST",
      headers,
      body,
    });

    if (!resp.ok) {
      throw new Error(`FCM HTTP ${resp.status}: ${await resp.text()}`);
    }

    const json = await resp.json();

    if (json.success === 1) {
      const result = json.results?.[0];
      // Canonical ID means FCM replaced the token — log but don't clean up here.
      if (result?.registration_id) {
        logger.info(
          { event: "fcm_canonical_id", old: deviceToken, new: result.registration_id },
          "FCM returned canonical registration ID",
        );
      }
      return {
        success: true,
        providerMessageId: result?.message_id,
      };
    }

    const error = json.results?.[0]?.error || "unknown FCM error";
    if (error === "NotRegistered" || error === "InvalidRegistration") {
      return { success: false, unregistered: true, error };
    }

    throw new Error(`FCM error: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// ExpoProvider (wraps expo-server-sdk, extracted from pushService.js)
// ---------------------------------------------------------------------------

const expoClient = new Expo(
  process.env.EXPO_ACCESS_TOKEN
    ? { accessToken: process.env.EXPO_ACCESS_TOKEN }
    : undefined,
);

class ExpoProvider {
  get providerName() {
    return "expo";
  }

  /** @param {string} token */
  validateToken(token) {
    return Expo.isExpoPushToken(token);
  }

  /**
   * @param {string} deviceToken
   * @param {{ title: string, body: string, data?: object }} payload
   * @returns {Promise<{success: boolean, providerMessageId?: string, unregistered?: boolean, error?: string}>}
   */
  async send(deviceToken, payload) {
    if (!Expo.isExpoPushToken(deviceToken)) {
      return { success: false, error: "Invalid Expo push token" };
    }

    const message = {
      to: deviceToken,
      sound: "default",
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
    };

    const [ticket] = await expoClient.sendPushNotificationsAsync([message]);

    if (ticket.status === "ok") {
      return { success: true, providerMessageId: ticket.id };
    }

    const error = ticket.details?.error || ticket.message || "unknown Expo error";
    if (error === "DeviceNotRegistered") {
      return { success: false, unregistered: true, error };
    }
    throw new Error(`Expo error: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Singleton provider instances
// ---------------------------------------------------------------------------

const _apnsProvider = new ApnsProvider();
const _fcmProvider = new FcmProvider();
const _expoProvider = new ExpoProvider();

// ---------------------------------------------------------------------------
// Provider selector
// ---------------------------------------------------------------------------

/**
 * Returns the primary provider for a given device platform and an optional
 * per-record override. Also returns the fallback (always ExpoProvider).
 *
 * @param {string|null} platform   'ios' | 'android' | other
 * @param {string|null} preference 'auto' | 'apns' | 'fcm' | 'expo' | null
 * @returns {{ primary: PushProvider, fallback: ExpoProvider, breaker: CircuitBreaker }}
 */
function selectProvider(platform, preference = "auto") {
  const pref = preference || "auto";

  if (pref === "apns") return { primary: _apnsProvider, breaker: apnsBreaker, fallback: _expoProvider };
  if (pref === "fcm")  return { primary: _fcmProvider,  breaker: fcmBreaker,  fallback: _expoProvider };
  if (pref === "expo") return { primary: _expoProvider, breaker: expoBreaker, fallback: _expoProvider };

  // Auto: route by platform.
  if (platform === "ios")     return { primary: _apnsProvider, breaker: apnsBreaker, fallback: _expoProvider };
  if (platform === "android") return { primary: _fcmProvider,  breaker: fcmBreaker,  fallback: _expoProvider };
  return { primary: _expoProvider, breaker: expoBreaker, fallback: _expoProvider };
}

// ---------------------------------------------------------------------------
// sendViaProvider — dispatch with circuit breaker + metrics + fallback
// ---------------------------------------------------------------------------

/**
 * Send a single push notification via the appropriate provider, falling
 * back to Expo on circuit-breaker OPEN or provider failure.
 *
 * @param {string}      deviceToken
 * @param {string|null} platform    Device platform from device_tokens.platform
 * @param {string|null} preference  Per-record provider_preference
 * @param {{ title: string, body: string, data?: object }} payload
 * @returns {Promise<{
 *   success: boolean,
 *   provider: string,
 *   outcome: 'delivered'|'failed'|'fallback'|'unregistered',
 *   providerMessageId?: string,
 *   unregistered?: boolean,
 *   error?: string,
 * }>}
 */
async function sendViaProvider(deviceToken, platform, preference, payload) {
  const { primary, breaker, fallback } = selectProvider(platform, preference);
  const startMs = Date.now();

  // ── Attempt primary provider ──────────────────────────────────────────────
  let usedFallback = false;
  let result;

  try {
    result = await breaker.call(() => primary.send(deviceToken, payload));
  } catch (primaryErr) {
    logger.warn(
      {
        event: "push_primary_failed",
        provider: primary.providerName,
        platform,
        err: primaryErr.message,
      },
      `Primary provider [${primary.providerName}] failed — falling back to Expo`,
    );

    if (primary.providerName === "expo") {
      const outcome = "failed";
      recordMetrics("expo", outcome, startMs);
      return {
        success: false,
        provider: "expo",
        outcome,
        error: primaryErr.message,
      };
    }

    // ── Fallback to ExpoProvider ─────────────────────────────────────────────
    usedFallback = true;
    try {
      result = await expoBreaker.call(() => fallback.send(deviceToken, payload));
    } catch (fallbackErr) {
      const outcome = "failed";
      recordMetrics(primary.providerName, outcome, startMs);
      return {
        success: false,
        provider: primary.providerName,
        outcome,
        error: fallbackErr.message,
      };
    }
  }

  // ── Map result to outcome label ───────────────────────────────────────────
  const effectiveProvider = usedFallback ? "expo" : primary.providerName;
  const outcome = result.unregistered
    ? "unregistered"
    : result.success
      ? (usedFallback ? "fallback" : "delivered")
      : "failed";

  recordMetrics(effectiveProvider, outcome, startMs);

  return {
    success: result.success,
    provider: effectiveProvider,
    outcome,
    providerMessageId: result.providerMessageId,
    unregistered: result.unregistered,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ApnsProvider,
  FcmProvider,
  ExpoProvider,
  selectProvider,
  sendViaProvider,
  // Breakers exposed for tests and health-check endpoints.
  breakers: { apnsBreaker, fcmBreaker, expoBreaker },
};
