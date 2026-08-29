/**
 * lib/apiClient.ts
 *
 * Centralized, pinned HTTP client for the mobile networking layer.
 *
 * Every request to the backend API should go through `apiClient` (axios) or
 * `pinnedFetch` (for the notification / error-reporting endpoints that use
 * `fetch`), so that the certificate-pinning policy from `lib/pinning.ts` is
 * asserted before the request is sent.
 *
 * Enforcement model
 * -----------------
 * React Native performs TLS validation natively and does not hand the verified
 * certificate to JS, so the JS layer enforces the *policy*:
 *
 *   1. Hosts that are bypassed (localhost, dev allowlist) or unconfigured are
 *      allowed through.
 *   2. Hosts with an active pinning policy are checked against the registered
 *      `PinningVerifier`. A verifier is supplied by the native bridge
 *      (Android Network Security Config / iOS TrustKit adapter) and throws
 *      `PinningError(PIN_MISMATCH)` when the peer certificate does not match.
 *   3. If a pinned host has no verifier registered, production builds fail
 *      closed (`PINNING_NOT_ENFORCED`) rather than silently sending traffic
 *      unpinned; development builds log a warning and continue.
 *
 * See `docs/mobile-pinning.md` for how to wire the native verifier and how to
 * generate the pins for a production backend.
 */
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";
import {
  PinRegistry,
  PinningPolicy,
  PinningError,
  isPinningBypassed,
  isHostPinned,
  normalizeHost,
  loadDefaultPolicy,
} from "./pinning";

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

// ─── Pinning state ────────────────────────────────────────────────────────

/**
 * A native (or test) certificate verifier. `verify(host)` must throw
 * `PinningError` when the peer certificate's SPKI pins do not match the
 * policy for `host`.
 */
export interface PinningVerifier {
  verify(host: string): Promise<void> | void;
}

const registry = new PinRegistry(loadDefaultPolicy());
let verifier: PinningVerifier | null = null;
// Dev allowlist is seeded from `EXPO_PUBLIC_PIN_ALLOWLIST` (comma-separated)
// and can be extended at runtime via `setPinningAllowlist`.
let devAllowlist: string[] = (process.env.EXPO_PUBLIC_PIN_ALLOWLIST || "")
  .split(",")
  .map((h) => normalizeHost(h))
  .filter(Boolean);

/** Register (or clear, with `null`) the native pinning verifier. */
export function registerPinningVerifier(v: PinningVerifier | null): void {
  verifier = v;
}

/** Replace the runtime pinning policy (e.g. after a remote pin update). */
export function setPinningPolicy(policy: PinningPolicy): void {
  registry.setPolicy(policy);
}

/** Access the runtime pinning policy registry. */
export function getPinningRegistry(): PinRegistry {
  return registry;
}

/** Add hostnames to the dev allowlist (comma-separated string or array). */
export function setPinningAllowlist(hosts: string[] | string): void {
  devAllowlist = (Array.isArray(hosts) ? hosts : String(hosts).split(","))
    .map((h) => normalizeHost(h))
    .filter(Boolean);
}

function isDevBuild(): boolean {
  return (
    typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production"
  );
}

/**
 * Assert that a request to `url` is permitted under the pinning policy.
 * Throws `PinningError` when the host is pinned but cannot be verified.
 */
export function assertPinningAllowed(
  url: string,
  options: { isDev?: boolean } = {},
): void {
  const host = normalizeHost(url);
  const isDev = options.isDev ?? isDevBuild();

  if (isPinningBypassed(registry.getPolicy(), host, { isDev, allowlist: devAllowlist })) {
    return;
  }
  if (!isHostPinned(registry.getPolicy(), host)) {
    return;
  }
  if (verifier) {
    verifier.verify(host);
    return;
  }
  if (isDev) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pinning] "${host}" is pinned but no verifier is registered; the native layer must enforce pinning in production builds.`,
    );
    return;
  }
  throw new PinningError(
    "PINNING_NOT_ENFORCED",
    host,
    `Pinning is configured for "${host}" but no verifier is registered. Refusing to send traffic unpinned in a production build.`,
  );
}

// ─── Axios client ─────────────────────────────────────────────────────────

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.request.use((config) => {
  const url =
    config.baseURL && config.url && !/^https?:\/\//i.test(config.url)
      ? `${config.baseURL}${config.url}`
      : config.url || "";
  assertPinningAllowed(url);
  return config;
});

// ─── Typed helpers ────────────────────────────────────────────────────────

/** GET and unwrap `response.data`. */
export async function apiGet<T = unknown>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res: AxiosResponse<T> = await apiClient.get<T>(url, config);
  return res.data;
}

/** POST and unwrap `response.data`. */
export async function apiPost<T = unknown>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res: AxiosResponse<T> = await apiClient.post<T>(url, body, config);
  return res.data;
}

/** PATCH and unwrap `response.data`. */
export async function apiPatch<T = unknown>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res: AxiosResponse<T> = await apiClient.patch<T>(url, body, config);
  return res.data;
}

/** DELETE and unwrap `response.data`. */
export async function apiDelete<T = unknown>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res: AxiosResponse<T> = await apiClient.delete<T>(url, config);
  return res.data;
}

/**
 * Pinned `fetch` wrapper for the notification / error-reporting endpoints
 * that use the Fetch API directly. Asserts the pinning policy before the
 * request is sent, then delegates to the platform `fetch`.
 */
export async function pinnedFetch(
  input: RequestInfo,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === "string" ? input : input.url;
  assertPinningAllowed(url);
  return fetch(input, init);
}
