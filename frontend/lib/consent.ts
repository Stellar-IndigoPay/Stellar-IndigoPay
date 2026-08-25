export type ConsentState = "undecided" | "granted" | "denied";

const CONSENT_STORAGE_KEY = "indigopay_analytics_consent";

type Listener = (state: ConsentState) => void;
const listeners: Set<Listener> = new Set();

function isEU() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const euTimezones = ["Europe/", "Atlantic/Canary", "Atlantic/Madeira"];
    return euTimezones.some((prefix) => tz.startsWith(prefix));
  } catch (e) {
    return false;
  }
}

export function getDefaultConsent(): ConsentState {
  // Stricter default (undecided/denied) for EU regions, otherwise undecided
  return isEU() ? "denied" : "undecided";
}

export function getConsent(): ConsentState {
  if (typeof window === "undefined") return "undecided";
  
  try {
    const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (stored === "granted" || stored === "denied") {
      return stored as ConsentState;
    }
  } catch (e) {
    // Storage unavailable (e.g. private mode) -> treat as denied
    return "denied";
  }
  
  return getDefaultConsent();
}

export function setConsent(state: ConsentState) {
  if (typeof window === "undefined") return;

  try {
    if (state === "undecided") {
      localStorage.removeItem(CONSENT_STORAGE_KEY);
    } else {
      localStorage.setItem(CONSENT_STORAGE_KEY, state);
    }
  } catch (e) {
    // Ignore storage errors, but still notify listeners of the in-memory change
  }

  listeners.forEach((listener) => listener(state));
}

export function onConsentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === CONSENT_STORAGE_KEY) {
      const newState = e.newValue as ConsentState | null;
      const parsedState = (newState === "granted" || newState === "denied") ? newState : getDefaultConsent();
      listeners.forEach((listener) => listener(parsedState));
    }
  });
}
