/**
 * lib/csp.ts — canonical constants for the Content Security Policy.
 *
 * The ONLY inline executable script the app renders is the pre-hydration
 * FOUC theme script below (see `pages/_document.tsx`).  Because its content
 * is fixed, we allow it via a CSP hash-source (`'sha256-…'`) rather than a
 * per-request nonce.  A hash is inherently cache-safe: the same script bytes
 * hash to the same value on every render, so SSG / ISR / edge-cached pages
 * never suffer the nonce-mismatch that a random nonce produces (closes #689).
 *
 * Keeping the script and its hash side-by-side lets the unit tests in
 * `__tests__/csp.test.ts` assert that `FOUC_THEME_SCRIPT_HASH` really is the
 * SHA-256 of `FOUC_THEME_SCRIPT`, so the two can never drift apart.
 *
 * NOTE: `next.config.mjs` also emits this hash as a static fallback.  It is a
 * plain ESM config file and cannot import this TypeScript module, so the hash
 * literal is duplicated there — keep it in sync with `FOUC_THEME_SCRIPT_HASH`.
 */

// Must mirror the logic in `lib/theme.tsx` (`applyThemeToDocument`) and read
// the same localStorage key (`THEME_STORAGE_KEY`) so the first paint matches
// what React hydrates into.
export const FOUC_THEME_SCRIPT = `(function(){try{var k="stellar-indigopay-theme";var m=window.localStorage.getItem(k);var sys=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var d=false;if(m==="dark"){d=true}else if(m==="light"){d=false}else if(sys){d=true}var r=document.documentElement;if(d){r.classList.add("dark");r.style.colorScheme="dark"}else{r.classList.remove("dark");r.style.colorScheme="light"}}catch(e){}})();`;

// Base64 SHA-256 of the exact string above.  Used as a `script-src` source
// expression so the browser allows this one inline script while still blocking
// any injected inline script whose content does not hash to this value.
export const FOUC_THEME_SCRIPT_HASH =
  "'sha256-ErtPdouQiLu8LLZozyBPb9ROeob7973X5nwZqhHweqY='";
