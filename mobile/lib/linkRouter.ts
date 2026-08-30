/**
 * lib/linkRouter.ts
 *
 * The single validated entry point for every inbound navigation surface in
 * the app: universal links, the custom URL scheme, QR codes, SEP-0007
 * `web+stellar:` payment requests, clipboard-pasted content, and
 * notification-derived links (#906).
 *
 * Before this module existed, each surface parsed and validated inbound
 * data with its own ad hoc code and the rules drifted between them — some
 * accepted unvalidated ids, some skipped scheme/host checks entirely,
 * malformed input could reach a screen (or a network call) unchecked. This
 * module is now the only place those rules live:
 *
 *   parseLink()   — pure, synchronous: scheme/host allowlist, length guard
 *                   (DoS guard on pathological inputs), duplicate-param
 *                   guard, entity-id/address/amount/memo format validation.
 *                   Never touches the network.
 *   resolveRoute() / resolveCanonicalProject() — async: confirms an entity
 *                   actually exists (and is active) against the backend
 *                   project registry, and returns the *canonical*
 *                   server-side name. Screens must render this canonical
 *                   name — never a name embedded in the inbound payload
 *                   itself, which is attacker-controlled (anti-phishing
 *                   guardrail).
 *   routeLink()   — convenience: parseLink() + resolveRoute() in one call.
 *
 * Every adapter — hooks/useDeepLink.ts (universal links + the custom
 * scheme), utils/notifications.ts (notification-derived links),
 * utils/clipboardLink.ts (clipboard-pasted content), utils/qrParser.ts (QR
 * codes), and utils/sep0007.ts (SEP-0007 payment requests) — calls into the
 * shared regex/validator exports below rather than re-implementing them.
 * See lib/__tests__/linkRouterConvergence.test.ts.
 */
import axios from "axios";
import { isValidStellarAddress } from "../utils/stellarValidation";
import {
  ACTIVE_PROJECT_STATUS,
  RegistryProject,
  resolveProjectByAddress,
} from "../utils/projectValidation";
import { captureException } from "./errorReporter";

export { isValidStellarAddress };
export type { RegistryProject };

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

/**
 * Hard cap on any raw inbound payload. Checked before any regex/URL work
 * touches the string — guards against pathological / denial-of-service
 * inputs (e.g. a QR code or clipboard paste containing megabytes of text).
 */
export const MAX_INPUT_LENGTH = 2000;

/** Schemes this app will parse. Everything else is rejected outright. */
export const ALLOWED_SCHEMES = [
  "indigopay",
  "stellar-indigopay",
  "web+stellar",
  "https",
] as const;

/** Hosts allowed for universal (https) links — mirrors app.json's
 * `associatedDomains` / Android `intentFilters`. */
export const ALLOWED_UNIVERSAL_HOSTS = ["indigopay.example.com"] as const;

// ── Entity id format ───────────────────────────────────────────────────
// Project/donation ids in this app may be either a backend-issued UUID
// (see backend/src/validators/schemas.js) or a short opaque slug used by
// earlier QR/deep-link formats ("proj-1"). Both are safe, bounded,
// URL-safe tokens, so one permissive-but-strict pattern covers both
// without breaking already-issued links: letters, digits, `-`/`_`,
// 1-64 chars, must start with an alphanumeric.
export const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 64-char hex transaction hash — mirrors backend/src/validators/schemas.js TX_HASH_RE. */
export const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;

export function isValidEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID_RE.test(value);
}

export function isValidTxHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH_RE.test(value);
}

/** Full-string match — `Number.parseFloat` alone would accept "5abc". */
const AMOUNT_RE = /^\d+(\.\d+)?$/;

export function isValidAmount(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!AMOUNT_RE.test(value)) return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Keep only amounts that are positive finite numbers ("50", "12.5"). */
export function sanitizeAmountParam(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return isValidAmount(trimmed) ? trimmed : undefined;
}

/** Truncate `value` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte code point. */
function truncateUtf8Bytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charBytes =
      codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    result += char;
  }
  return result;
}

/** Stellar text memos max out at 28 bytes; trim anything longer. `maxLength`
 * is a byte count, not a character count — non-ASCII memos are truncated by
 * UTF-8 byte length so the result never exceeds what Stellar will accept.
 * Other free-text fields (SEP-0007 `message`) may pass a larger
 * `maxLength`. */
export function sanitizeMemoParam(
  value: string | null | undefined,
  maxLength = 28,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncateUtf8Bytes(trimmed, maxLength);
}

/**
 * True when `key` appears more than once in `params`. A payload trying to
 * smuggle two different values for the same field is rejected outright
 * rather than silently taking "the first" or "the last" one — duplicate
 * params are a classic request-smuggling / validator-bypass vector.
 */
export function hasDuplicateParam(
  params: URLSearchParams,
  key: string,
): boolean {
  return params.getAll(key).length > 1;
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding — fall back to the raw token rather than
    // throwing, the format validators below will reject it if unsafe.
    return value;
  }
}

// ── Shared payload regexes (single source of truth) ─────────────────────
export const DEEP_LINK_RE = /^stellar-indigopay:\/\/donate\?(.*)$/i;
export const LEGACY_DEEP_LINK_RE = /^indigopay:\/\/donate\?(.*)$/i;
export const PATH_LINK_RE = /^indigopay:\/\/(donate|project)\/([^/?#]*)/i;
// Group 2 must include `?` (only `#` is excluded) so the query string
// reaches parseUniversalLink()'s own `pathAndQuery.split("?")` below —
// excluding `?` here would silently drop amount/memo/name params (and the
// duplicate-param guard that covers them) for every universal link.
export const UNIVERSAL_LINK_RE = /^https:\/\/([^/?#]+)(\/[^#]*)?/i;
export const SEP0007_PAY_RE = /^web\+stellar:pay\?(.*)$/i;
export const RAW_ADDRESS_RE = /^(G[A-Z0-9]{55})$/;
export const EMBEDDED_ADDRESS_RE = /(G[A-Z0-9]{55})/;

const SUPPORTED_MEMO_TYPES = new Set(["text", "id", "hash", "return"]);

// Surfaces where "loose text containing an address" is a reasonable inbound
// shape (a physical QR code, or arbitrary clipboard content). Programmatic
// surfaces (deep link / universal link / notification) must match a
// structured shape — free-text matching there is exactly the kind of ad
// hoc misroute vector #906 exists to close.
const FREE_TEXT_SURFACES = new Set<LinkSurface>(["qr", "clipboard"]);

// ── Types ────────────────────────────────────────────────────────────────
export type LinkSurface =
  | "universal_link"
  | "custom_scheme"
  | "qr"
  | "sep0007"
  | "clipboard"
  | "notification";

export interface DonateRouteTarget {
  kind: "donate";
  projectId?: string;
  address?: string;
  amount?: string;
  memo?: string;
  /**
   * Display name embedded in the payload itself (e.g. a `name=` query
   * param). This is attacker-controlled and MUST NEVER be rendered
   * as-is — it exists only for diagnostics/telemetry. Screens must render
   * `canonicalName` (populated by resolveRoute) instead.
   */
  untrustedName?: string;
  /** Populated by resolveRoute()/resolveCanonicalProject() after a
   * successful, live registry lookup. This is the only name safe to render. */
  canonicalName?: string;
}

export interface ProjectRouteTarget {
  kind: "project";
  projectId: string;
  untrustedName?: string;
  canonicalName?: string;
}

export interface ProfileRouteTarget {
  kind: "profile";
  address: string;
}

export interface Sep0007PayRouteTarget {
  kind: "sep0007_pay";
  destination: string;
  amount?: string;
  memo?: string;
  memoType?: "text" | "id" | "hash" | "return";
  assetCode?: string;
  assetIssuer?: string;
  message?: string;
  callback?: string;
  networkPassphrase?: string;
}

export type RouteTarget =
  | DonateRouteTarget
  | ProjectRouteTarget
  | ProfileRouteTarget
  | Sep0007PayRouteTarget;

export type RejectionReason =
  | "empty"
  | "too_long"
  | "scheme_not_allowed"
  | "host_not_allowed"
  | "duplicate_params"
  | "invalid_entity_id"
  | "invalid_address"
  | "invalid_amount"
  | "invalid_tx_hash"
  | "malformed"
  | "entity_not_found"
  | "entity_inactive";

export interface RouteRejected {
  status: "rejected";
  surface: LinkSurface;
  raw: string;
  reason: RejectionReason;
  detail?: string;
}

export interface RouteFallback {
  status: "fallback";
  surface: LinkSurface;
  raw: string;
}

export interface RouteValid {
  status: "valid";
  surface: LinkSurface;
  raw: string;
  target: RouteTarget;
}

export type RouteResult = RouteValid | RouteRejected | RouteFallback;

function rejected(
  surface: LinkSurface,
  raw: string,
  reason: RejectionReason,
  detail?: string,
): RouteRejected {
  return { status: "rejected", surface, raw, reason, detail };
}
function fallbackResult(surface: LinkSurface, raw: string): RouteFallback {
  return { status: "fallback", surface, raw };
}
function valid(
  surface: LinkSurface,
  raw: string,
  target: RouteTarget,
): RouteValid {
  return { status: "valid", surface, raw, target };
}

// ── Parsing branches ─────────────────────────────────────────────────────

function parseDonateQuery(
  raw: string,
  surface: LinkSurface,
  queryStr: string,
): RouteResult {
  const params = new URLSearchParams(queryStr);
  if (
    hasDuplicateParam(params, "projectId") ||
    hasDuplicateParam(params, "address") ||
    hasDuplicateParam(params, "amount") ||
    hasDuplicateParam(params, "memo")
  ) {
    return rejected(surface, raw, "duplicate_params");
  }

  const projectIdRaw = params.get("projectId")?.trim();
  let projectId: string | undefined;
  if (projectIdRaw) {
    if (!isValidEntityId(projectIdRaw)) {
      return rejected(surface, raw, "invalid_entity_id", "projectId");
    }
    projectId = projectIdRaw;
  }

  const addressRaw = params.get("address")?.trim();
  let address: string | undefined;
  if (addressRaw) {
    if (!isValidStellarAddress(addressRaw)) {
      return rejected(surface, raw, "invalid_address");
    }
    address = addressRaw;
  }

  if (!projectId && !address) {
    return rejected(surface, raw, "malformed", "missing projectId/address");
  }

  return valid(surface, raw, {
    kind: "donate",
    projectId,
    address,
    amount: sanitizeAmountParam(params.get("amount")),
    memo: sanitizeMemoParam(params.get("memo")),
    untrustedName: params.get("name")?.trim() || undefined,
  });
}

function parseLegacyDonateQuery(
  raw: string,
  surface: LinkSurface,
  queryStr: string,
): RouteResult {
  const params = new URLSearchParams(queryStr);
  if (
    hasDuplicateParam(params, "wallet") ||
    hasDuplicateParam(params, "project") ||
    hasDuplicateParam(params, "amount") ||
    hasDuplicateParam(params, "memo")
  ) {
    return rejected(surface, raw, "duplicate_params");
  }

  const wallet = params.get("wallet")?.trim() ?? "";
  if (!isValidStellarAddress(wallet)) {
    return rejected(surface, raw, "invalid_address");
  }

  const projectIdRaw = params.get("project")?.trim();
  let projectId: string | undefined;
  if (projectIdRaw) {
    if (!isValidEntityId(projectIdRaw)) {
      return rejected(surface, raw, "invalid_entity_id", "project");
    }
    projectId = projectIdRaw;
  }

  return valid(surface, raw, {
    kind: "donate",
    projectId,
    address: wallet,
    amount: sanitizeAmountParam(params.get("amount")),
    memo: sanitizeMemoParam(params.get("memo")),
  });
}

function parsePathLink(
  raw: string,
  surface: LinkSurface,
  segment: string,
  param: string,
): RouteResult {
  const trimmedParam = param.trim();
  if (!trimmedParam) {
    return rejected(surface, raw, "malformed", "missing id");
  }

  if (segment === "project") {
    if (!isValidEntityId(trimmedParam)) {
      return rejected(surface, raw, "invalid_entity_id");
    }
    return valid(surface, raw, { kind: "project", projectId: trimmedParam });
  }

  // segment === "donate": the path param may be a project id, or — for
  // legacy `indigopay://donate/<address>` links — a raw wallet address.
  if (isValidStellarAddress(trimmedParam)) {
    return valid(surface, raw, { kind: "donate", address: trimmedParam });
  }
  if (isValidEntityId(trimmedParam)) {
    return valid(surface, raw, { kind: "donate", projectId: trimmedParam });
  }
  return rejected(surface, raw, "invalid_entity_id");
}

function parseUniversalLink(
  raw: string,
  surface: LinkSurface,
  hostRaw: string,
  pathAndQuery: string,
): RouteResult {
  const host = hostRaw.toLowerCase();
  if (!(ALLOWED_UNIVERSAL_HOSTS as readonly string[]).includes(host)) {
    return rejected(surface, raw, "host_not_allowed", host);
  }

  const [pathname, queryStr = ""] = pathAndQuery.split("?");
  const segMatch = pathname.match(/^\/(project|donate)\/([^/]+)/i);
  if (!segMatch) {
    return fallbackResult(surface, raw);
  }
  const segment = segMatch[1].toLowerCase();
  const param = decodeSafely(segMatch[2]);

  const params = new URLSearchParams(queryStr);
  if (
    hasDuplicateParam(params, "amount") ||
    hasDuplicateParam(params, "memo") ||
    hasDuplicateParam(params, "name")
  ) {
    return rejected(surface, raw, "duplicate_params");
  }

  const base = parsePathLink(raw, surface, segment, param);
  if (base.status !== "valid") return base;

  const untrustedName = params.get("name")?.trim() || undefined;
  if (base.target.kind === "donate") {
    return valid(surface, raw, {
      ...base.target,
      amount: sanitizeAmountParam(params.get("amount")),
      memo: sanitizeMemoParam(params.get("memo")),
      untrustedName,
    });
  }
  if (base.target.kind === "project") {
    return valid(surface, raw, { ...base.target, untrustedName });
  }
  return base;
}

function parseSep0007(raw: string, surface: LinkSurface): RouteResult {
  // Normalise the scheme's case ("Web+Stellar:" -> "web+stellar:") without
  // touching the rest of the payload — destinations/memos are
  // case-sensitive.
  const rest = raw.slice(raw.indexOf(":") + 1);
  const opMatch = rest.match(/^([a-zA-Z]+)\??(.*)$/s);
  const operation = (opMatch?.[1] || "").toLowerCase();
  const queryStr = opMatch?.[2] || "";

  if (operation !== "pay") {
    // "tx" (arbitrary transaction signing) and anything else is owned by
    // the dedicated wallet SEP-0007 signer, not the donation link router.
    return fallbackResult(surface, raw);
  }

  const params = new URLSearchParams(queryStr);
  if (
    hasDuplicateParam(params, "destination") ||
    hasDuplicateParam(params, "amount") ||
    hasDuplicateParam(params, "memo")
  ) {
    return rejected(surface, raw, "duplicate_params");
  }

  const destination = params.get("destination")?.trim() ?? "";
  if (!isValidStellarAddress(destination)) {
    return rejected(surface, raw, "invalid_address");
  }

  const memoType = params.get("memo_type")?.toLowerCase();

  const target: Sep0007PayRouteTarget = {
    kind: "sep0007_pay",
    destination,
    amount: sanitizeAmountParam(params.get("amount")),
    memo: sanitizeMemoParam(params.get("memo"), 64),
    memoType: memoType && SUPPORTED_MEMO_TYPES.has(memoType)
      ? (memoType as Sep0007PayRouteTarget["memoType"])
      : undefined,
    assetCode: params.get("asset_code")?.trim() || undefined,
    assetIssuer: params.get("asset_issuer")?.trim() || undefined,
    message: params.get("message")?.trim() || undefined,
    callback: params.get("callback")?.trim() || undefined,
    networkPassphrase: params.get("network_passphrase")?.trim() || undefined,
  };
  return valid(surface, raw, target);
}

/**
 * Parse + validate a raw inbound payload. Pure and synchronous — never
 * touches the network. See the module docstring for the full pipeline.
 */
export function parseLink(raw: unknown, surface: LinkSurface): RouteResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return rejected(surface, typeof raw === "string" ? raw : "", "empty");
  }
  // DoS / truncation guard — checked on the *original* string, before any
  // regex touches it, and the raw payload is never echoed back in full.
  if (raw.length > MAX_INPUT_LENGTH) {
    return rejected(
      surface,
      raw.slice(0, 64),
      "too_long",
      `input exceeded ${MAX_INPUT_LENGTH} chars`,
    );
  }

  const input = raw.trim();

  // ── SEP-0007 payment URI (case-insensitive scheme) ──────────────────
  if (/^web\+stellar:/i.test(input)) {
    return parseSep0007(input, surface);
  }

  // ── Preferred IndigoPay deep link: stellar-indigopay://donate?... ───
  const deepLinkMatch = input.match(DEEP_LINK_RE);
  if (deepLinkMatch) {
    return parseDonateQuery(input, surface, deepLinkMatch[1]);
  }

  // ── Legacy deep link: indigopay://donate?wallet=...&project=... ─────
  const legacyMatch = input.match(LEGACY_DEEP_LINK_RE);
  if (legacyMatch) {
    return parseLegacyDonateQuery(input, surface, legacyMatch[1]);
  }

  // ── Path-style custom scheme: indigopay://donate/<id> | indigopay://project/<id> ──
  const pathMatch = input.match(PATH_LINK_RE);
  if (pathMatch) {
    return parsePathLink(
      input,
      surface,
      pathMatch[1].toLowerCase(),
      decodeSafely(pathMatch[2]),
    );
  }

  // ── Universal link: https://indigopay.example.com/project/<id> | /donate/<id> ──
  const universalMatch = input.match(UNIVERSAL_LINK_RE);
  if (universalMatch) {
    return parseUniversalLink(
      input,
      surface,
      universalMatch[1],
      universalMatch[2] || "",
    );
  }

  // ── Any other recognised-but-unsupported scheme ──────────────────────
  const schemeMatch = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) {
      return rejected(surface, input, "scheme_not_allowed", scheme);
    }
    return rejected(surface, input, "malformed");
  }

  // ── Loose text: raw / embedded Stellar address (QR + clipboard only) ──
  // Programmatic surfaces must match a structured shape above; matching
  // free text there would reintroduce the ad hoc misroute risk #906 closes.
  if (FREE_TEXT_SURFACES.has(surface)) {
    const rawAddress = input.match(RAW_ADDRESS_RE);
    if (rawAddress && isValidStellarAddress(rawAddress[1])) {
      return valid(surface, input, { kind: "donate", address: rawAddress[1] });
    }
    const embedded = input.match(EMBEDDED_ADDRESS_RE);
    if (embedded && isValidStellarAddress(embedded[1])) {
      return valid(surface, input, { kind: "donate", address: embedded[1] });
    }
  }

  return fallbackResult(surface, input);
}

// ── Canonical-data resolution (anti-phishing guardrail) ─────────────────

/**
 * Fetch the live project registry and resolve a project by id or wallet
 * address. This is the *only* source of truth for a project's display
 * name — never the name embedded in an inbound link/QR/notification
 * payload, which is attacker-controlled.
 *
 * Mirrors the registry fetch already used by app/scan.tsx's
 * `lookupAddress`, generalised to also resolve by id.
 */
export async function resolveCanonicalProject(query: {
  projectId?: string;
  address?: string;
}): Promise<RegistryProject | null> {
  if (!query.projectId && !query.address) return null;
  try {
    // Id-based lookups go straight to the single-project endpoint — the
    // list endpoint below is capped at 100 rows, which would silently
    // "not found" any valid project outside that page.
    if (query.projectId) {
      const res = await axios.get(
        `${API_URL}/api/projects/${encodeURIComponent(query.projectId)}`,
      );
      const project = res.data?.data as RegistryProject | undefined;
      return project?.id ? project : null;
    }

    const res = await axios.get(`${API_URL}/api/projects?limit=100`);
    const list: RegistryProject[] = Array.isArray(res.data?.data)
      ? res.data.data
      : [];
    if (query.address) {
      const result = resolveProjectByAddress(list, query.address);
      if (result.kind !== "unknown") return result.project;
    }
    return null;
  } catch {
    // Fail closed: on a lookup error we cannot confirm the entity exists,
    // so callers must treat this the same as "not found".
    return null;
  }
}

/**
 * Confirm a parsed "donate"/"project" target against the live backend
 * registry and attach the canonical (server-side) name. Entities that no
 * longer exist, or projects that are not active, are downgraded to a
 * rejection so the caller can show a safe fallback instead of navigating
 * to a donation screen for an unverified/deleted/inactive destination.
 *
 * Targets that don't reference a project (SEP-0007 pay, donor profile)
 * pass through unchanged — SEP-0007 destinations are arbitrary external
 * Stellar accounts by design, and profile lookups render their own
 * canonical data on the profile screen itself.
 */
export async function resolveRoute(result: RouteResult): Promise<RouteResult> {
  if (result.status !== "valid") return result;
  const { target } = result;

  if (target.kind !== "donate" && target.kind !== "project") {
    return result;
  }

  // A donate target with neither id nor address never reaches here (parseLink
  // rejects it), so at least one of the two is always present.
  const project = await resolveCanonicalProject({
    projectId: target.kind === "project" ? target.projectId : target.projectId,
    address: target.kind === "donate" ? target.address : undefined,
  });

  if (!project) {
    return rejected(result.surface, result.raw, "entity_not_found");
  }
  if (project.status !== ACTIVE_PROJECT_STATUS) {
    return rejected(result.surface, result.raw, "entity_inactive");
  }

  return valid(result.surface, result.raw, {
    ...target,
    projectId: project.id,
    canonicalName: project.name,
  } as RouteTarget);
}

/**
 * Convenience wrapper: parseLink() + resolveRoute() in one call. Adapters
 * that need a confirmed, canonical-data-backed result (rather than just
 * format validation) should use this.
 */
export async function routeLink(
  raw: unknown,
  surface: LinkSurface,
): Promise<RouteResult> {
  return resolveRoute(parseLink(raw, surface));
}

// ── Navigation path builder ──────────────────────────────────────────────

/** Map a validated RouteTarget to the expo-router path it should push. */
export function buildRoutePath(target: RouteTarget): string {
  switch (target.kind) {
    case "project":
      return `/project/${encodeURIComponent(target.projectId)}`;
    case "profile":
      return `/profile/${encodeURIComponent(target.address)}`;
    case "donate": {
      const id = target.projectId ?? target.address;
      if (!id) return "/donate";
      const query = new URLSearchParams();
      if (target.amount) query.set("amount", target.amount);
      if (target.memo) query.set("memo", target.memo);
      const qs = query.toString();
      return `/donate/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
    }
    case "sep0007_pay": {
      const query = new URLSearchParams();
      query.set("destination", target.destination);
      if (target.amount) query.set("amount", target.amount);
      if (target.memo) query.set("memo", target.memo);
      if (target.memoType) query.set("memo_type", target.memoType);
      if (target.assetCode) query.set("asset_code", target.assetCode);
      if (target.assetIssuer) query.set("asset_issuer", target.assetIssuer);
      if (target.message) query.set("message", target.message);
      if (target.callback) query.set("callback", target.callback);
      if (target.networkPassphrase)
        query.set("network_passphrase", target.networkPassphrase);
      return `/sep0007?uri=${encodeURIComponent(`web+stellar:pay?${query.toString()}`)}`;
    }
    default:
      return "/";
  }
}

// ── Post-consent telemetry ───────────────────────────────────────────────

/**
 * Report a rejected/fallback link for diagnostics. This is a strictly
 * post-consent, fire-and-forget call — it must never be invoked
 * automatically for every hostile input a device happens to receive
 * without the user opting in (e.g. from a "report a problem" affordance
 * on the fallback screen), since the raw payload may contain
 * user-identifying data. No-ops silently when `consent` is false.
 */
export async function reportLinkRejection(
  result: RouteRejected | RouteFallback,
  consent: boolean,
): Promise<void> {
  if (!consent) return;
  try {
    await captureException(new Error(`inbound link rejected: ${result.status}`), {
      surface: result.surface,
      reason: result.status === "rejected" ? result.reason : "fallback",
      detail: result.status === "rejected" ? result.detail : undefined,
      // Cap what we forward — never the full raw payload.
      rawPreview: result.raw.slice(0, 64),
    });
  } catch {
    // Telemetry is best-effort and must never surface an error to the caller.
  }
}
