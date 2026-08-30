/**
 * src/services/screeningRules.js
 *
 * Deterministic, side-effect-free rule engine for the project-update
 * moderation pipeline (issue #935). Running these rules costs no I/O and no
 * wall-clock time, so the submission path can apply them inline and fast-path
 * approve obviously-clean content without ever touching the AI service.
 *
 * Rules are split by severity:
 *   - HARD  — confirmed phishing / scam signals (denylisted hosts, raw-IP
 *             links combined with credential-adjacent keywords, brand
 *             lookalikes). A hard hit auto-quarantines the update and raises
 *             an alert; the admin queue is the only way back to `live`.
 *   - SOFT  — spam/profanity heuristics and link-density. A soft hit leaves
 *             the update in `pending-screening` while the AI service decides;
 *             non-English content with no rule hits also flows through AI
 *             ("AI fallback").
 *
 * The engine never learns and never stores state — every call returns the
 * same output for the same input, which is what makes the results auditable
 * and re-runnable.
 */

"use strict";

const SEVERITY = Object.freeze({
  HARD: "hard",
  SOFT: "soft",
});

// Decisions the fast-path can emit.
const DECISION = Object.freeze({
  APPROVED: "approved", // no hits — fast-path live
  REVIEW: "review", // soft hits only — needs AI / human review
  QUARANTINE: "quarantine", // hard hits — auto-quarantine + alert
});

// ---------------------------------------------------------------------------
// URL extraction / classification
// ---------------------------------------------------------------------------

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'\u201c\u201d]+/gi;

function extractUrls(text) {
  return (String(text || "").match(URL_RE) || []).map((raw) => raw.replace(/[.,;:!?)\]}]+$/, ""));
}

function hostnameOf(url) {
  try {
    const u = new URL(url.startsWith("http") ? url : `http://${url}`);
    return {
      host: u.hostname.toLowerCase().replace(/^www\./, ""),
      port: u.port,
      protocol: u.protocol,
    };
  } catch {
    // Not parseable as a URL — treat the raw, lowercased string as a host.
    const cleaned = String(url).toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");
    return { host: cleaned, port: "", protocol: "" };
  }
}

// Hosts we never flag. A donation-platform update pointing at the platform's
// own docs, an upstream repo, or a mainstream outlet is not phishing, even if
// a keyword heuristic would otherwise fire.
const URL_ALLOWLIST = new Set([
  "resend.com",
  "github.com",
  "gist.github.com",
  "stellar.org",
  "developers.stellar.org",
  "youtube.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "medium.com",
  "substack.com",
]);

// Known link-abbreviation services. Benign on their own, but only confident
// phishing hits (a shortener payload combined with crypto/credential speech)
// are treated as hard; a bare shortened link is a soft signal.
const URL_SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "buff.ly",
  "goo.gl",
  "t.co",
  "shorturl.at",
  "rebrand.ly",
  "cutt.ly",
]);

const RAW_IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/;

// Brand lookalikes — the classic donor-phishing pattern. A host is a lookalike
// when it contains a guarded brand token but is NOT the brand's real domain:
//   paypal-confirm-now.xyz, walletconnect-verify.io, freighter-login.top …
// Payment / wallet brands are hard (auto-quarantine): impersonating a payment
// rail is a confirmed scam pattern. The generic "stellar" token is soft only —
// plenty of legitimate community domains reuse the network's name, so a human
// (or AI) review is the right call there.
const BRAND_LOOKALIKES = [
  { anchor: "paypal", legit: /(^|\.)paypal\.com$/, severity: SEVERITY.HARD },
  { anchor: "coinbase", legit: /(^|\.)coinbase\.com$/, severity: SEVERITY.HARD },
  { anchor: "binance", legit: /(^|\.)binance\.com$/, severity: SEVERITY.HARD },
  { anchor: "metamask", legit: /(^|\.)metamask\.io$/, severity: SEVERITY.HARD },
  { anchor: "walletconnect", legit: /(^|\.)walletconnect\.com$/, severity: SEVERITY.HARD },
  { anchor: "lobstr", legit: /(^|\.)lobstr\.co$/, severity: SEVERITY.HARD },
  { anchor: "freighter", legit: /(^|\.)freighter\.app$/, severity: SEVERITY.HARD },
  { anchor: "stellar", legit: /(^|\.)stellar\.org$/, severity: SEVERITY.SOFT },
];

// Keyword phrases that, next to an outbound link, point at credential / crypto
// harvesting rather than a project update. These are deliberately narrow to
// keep false positives low.
const PHISHING_KEYWORD_RES = [
  /verify\s+(your\s+)?(wallet|account|identity)/i,
  /connect\s+(your\s+)?wallet/i,
  /(import|recover|restore)\s+(your\s+)?(wallet|seed)/i,
  /claim\s+(your\s+)?(reward|airdrop|prize)/i,
  /(double|2x|10x|x2)\s+(your\s+)?xlm/i,
  /send\s+\d+(\.\d+)?\s*xlm\s+(to\s+|and\s+get)/i,
  /urgent:?\s*(verify|confirm)/i,
  /wallet\s*(rarely|never|security).*(click|connect|link)/i,
];

// ---------------------------------------------------------------------------
// Profanity + spam heuristics
// ---------------------------------------------------------------------------

const PROFANITY_RES = [
  /\bfuck(ing|er|ed)?\b/i,
  /\bshit(head)?\b/i,
  /\bslut\b/i,
  /\bwhore\b/i,
  /\bbitch(es)?\b/i,
  /\bnigga\b/i,
  /\bdamn\b/i,
  /\bass\b/i,
  /\bcunt\b/i,
  /\bdick\b/i,
];

const SPAM_PHRASES = [
  /(free|get|win)\s+(money|cash|bitcoin|btc|eth|xlm)/i,
  /\bguaranteed\s+(profit|return|income)\b/i,
  /\bmake\s+\$\d+.*(hour|day|week)\b/i,
  /\bclick\s+here\b/i,
  /\bact\s+now\b/i,
  /\blocked\s+account\b/i,
  /\bsuspended\s+account\b/i,
  /\bupdate\s+(your|the)\s+(payment|account)\s+details\b/i,
  /\bbuy\s+(now|today)\b/i,
  /\bno[-\s]*risk\b/i,
];

const REPEATED_PUNCTUATION_RE = /([!?]{2,}|([.]{4,}))/;
const REPEATED_CHAR_RE = /(.)\1{4,}/;
const ALL_CAPS_WORD_RE = /\b[A-Z]{4,}\b/g;

// Someone talking money in all caps with sparse content is textbook spam.
const MONEY_TOKEN_RE = /(\$|usd|€|£|btc|eth|xlm)/i;

// ---------------------------------------------------------------------------
// Public engine
// ---------------------------------------------------------------------------

/**
 * Run the full rule matrix over an update's title + body.
 *
 * @param {{ title: string, body: string }} input
 * @returns {{
 *   decision: 'approved'|'review'|'quarantine',
 *   confidence: number,
 *   ruleHits: Array<{ rule: string, severity: 'hard'|'soft', detail?: string }>,
 *   urls: string[],
 *   shortenings: number
 * }}
 */
function runRuleScreening({ title = "", body = "" }) {
  const text = `${title || ""}\n${body || ""}`;
  const urls = extractUrls(text);
  const shortenings = [];
  const ruleHits = [];

  // ── URL / phishing rules ──────────────────────────────────────────────
  for (const url of urls) {
    const { host, port } = hostnameOf(url);

    if (URL_ALLOWLIST.has(host)) continue;

    if (RAW_IP_RE.test(host) && !port) {
      ruleHits.push({
        rule: "phishing.raw_ip_host",
        severity: SEVERITY.HARD,
        detail: host,
      });
      continue;
    }

    const lookalike = BRAND_LOOKALIKES.find((brand) => {
      if (!host.includes(brand.anchor)) return false;
      if (brand.legit.test(host)) return false;
      return true;
    });
    if (lookalike) {
      ruleHits.push({
        rule: "phishing.lookalike_domain",
        severity: lookalike.severity,
        detail: host,
      });
      if (lookalike.severity === SEVERITY.HARD) {
        // The common "verify/connect at <brand>-lookalike" framing reinforces
        // the phishing verdict; note it once per host.
        ruleHits.push({
          rule:
            /(verify|connect|wallet|claim|login|secure)/i.test(text)
              ? "phishing.lookalike_credential_framing"
              : "phishing.lookalike_domain",
          severity: SEVERITY.HARD,
          detail: host,
        });
        break;
      }
    }

    if (URL_SHORTENERS.has(host)) {
      shortenings.push(host);
    }
  }

  // A hard host hit is already decisive; keyword escalation only matters for
  // content whose links are otherwise benign or shortened.
  const hasHardLink = ruleHits.some((h) => h.severity === SEVERITY.HARD);

  if (urls.length > 0 && !hasHardLink) {
    for (const phrase of PHISHING_KEYWORD_RES) {
      if (phrase.test(text)) {
        const shortenerSkew =
          shortenings.length > 0 && /(wallet|xlm|verify|claim|prize|account)/i.test(text);
        ruleHits.push({
          rule: shortenerSkew
            ? "phishing.shortened_credential_phrase"
            : "phishing.credential_phrase",
          severity: shortenerSkew ? SEVERITY.HARD : SEVERITY.SOFT,
          detail: phrase.source,
        });
      }
    }
  } else if (urls.length === 0 && /(verify|claim|airdrop|wallet|xlm)\b/i.test(text)) {
    // No links at all: a bare "airdrop" / "verify" sentence is at most a soft
    // review signal, never a hard one — it may be a legitimate update.
    for (const phrase of PHISHING_KEYWORD_RES) {
      if (phrase.test(text)) {
        ruleHits.push({
          rule: "phishing.credential_phrase",
          severity: SEVERITY.SOFT,
          detail: phrase.source,
        });
      }
    }
  }

  // ── Spam heuristics ───────────────────────────────────────────────────
  const capsMatches = text.match(ALL_CAPS_WORD_RE) || [];
  const capsWords = capsMatches.length;
  const totalWords = Math.max(text.split(/\s+/).filter(Boolean).length, 1);
  const capsRatio = capsWords / totalWords;

  if (REPEATED_PUNCTUATION_RE.test(text)) {
    ruleHits.push({ rule: "spam.repeated_punctuation", severity: SEVERITY.SOFT });
  }
  if (REPEATED_CHAR_RE.test(text)) {
    ruleHits.push({ rule: "spam.repeated_characters", severity: SEVERITY.SOFT });
  }
  if (capsRatio >= 0.5 && capsWords >= 3 && MONEY_TOKEN_RE.test(text)) {
    ruleHits.push({ rule: "spam.shouted_money", severity: SEVERITY.SOFT });
  }
  if (urls.length > 1 && totalWords <= urls.length * 6) {
    ruleHits.push({ rule: "spam.link_density", severity: SEVERITY.SOFT });
  }

  for (const phrase of SPAM_PHRASES) {
    if (phrase.test(text)) {
      ruleHits.push({
        rule: "spam.buzz_phrase",
        severity: SEVERITY.SOFT,
        detail: phrase.source,
      });
    }
  }

  // ── Profanity ─────────────────────────────────────────────────────────
  for (const profanity of PROFANITY_RES) {
    if (profanity.test(text)) {
      ruleHits.push({
        rule: "profanity.detected",
        severity: SEVERITY.SOFT,
        detail: profanity.source,
      });
    }
  }

  // ── Decision ──────────────────────────────────────────────────────────
  const hard = ruleHits.filter((h) => h.severity === SEVERITY.HARD);
  if (hard.length > 0) {
    return {
      decision: DECISION.QUARANTINE,
      confidence: 1.0,
      ruleHits,
      urls,
      shortenings,
    };
  }

  const soft = ruleHits.filter((h) => h.severity === SEVERITY.SOFT);
  if (soft.length > 0) {
    // Confidence grows with corroborating signals, capped below the
    // hard-violation threshold so a pure-rule auto-quarantine never fires
    // on soft-only content.
    const confidence = Math.min(0.9, 0.4 + 0.15 * soft.length);
    return {
      decision: DECISION.REVIEW,
      confidence: Number(confidence.toFixed(2)),
      ruleHits,
      urls,
      shortenings,
    };
  }

  return {
    decision: DECISION.APPROVED,
    confidence: 0.8,
    ruleHits,
    urls,
    shortenings,
  };
}

module.exports = {
  SEVERITY,
  DECISION,
  extractUrls,
  hostnameOf,
  runRuleScreening,
  URL_ALLOWLIST,
  URL_SHORTENERS,
};