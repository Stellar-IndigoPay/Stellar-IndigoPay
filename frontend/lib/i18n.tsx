/**
 * lib/i18n.tsx — Lightweight i18n context with JSON locale files, pluralization, and interpolation.
 *
 * RTL support: any locale whose writing system is right-to-left (Arabic,
 * Hebrew, Farsi, …) is detected via `isRTL()` and the provider keeps
 * `document.documentElement.dir` / `lang` in sync, so the whole page
 * mirrors without per-component CSS. Adding a new RTL locale (e.g.
 * `locales/ar.json`) only requires extending `RTL_LOCALES` + `locales`.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import fr from "@/locales/fr.json";

export type Locale = "en" | "es" | "fr";

const locales: Record<Locale, Record<string, any>> = { en, es, fr };

/**
 * BCP-47 tags whose scripts are written right-to-left. `iw` is the legacy
 * tag for Hebrew and is included so persisted/pre-1995 tags still mirror.
 */
export const RTL_LOCALES: ReadonlySet<string> = new Set([
  "ar",
  "he",
  "iw",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "yi",
]);

/** Returns `true` when `locale` uses a right-to-left writing system. */
export function isRTL(locale: string): boolean {
  return RTL_LOCALES.has(locale.toLowerCase());
}

/**
 * Keep `document.documentElement` in sync with the active locale so CSS
 * direction (`dir`) and language (`lang`) always match what is rendered.
 * No-op during SSR (no `document`).
 */
function applyDocumentDirection(locale: Locale | string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = isRTL(locale) ? "rtl" : "ltr";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  tPlural: (
    key: string,
    count: number,
    params?: Record<string, string | number>
  ) => string;
}

function get(obj: Record<string, any>, path: string): any {
  return path.split(".").reduce((acc: any, part) => acc?.[part], obj);
}

const defaultT = (
  key: string,
  params?: Record<string, string | number>
): string => {
  let message = get(en, key) ?? key;
  if (typeof message !== "string") {
    message = key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      message = message.replace(
        new RegExp(`\\{\\{${k}\\}\\}|\\{${k}\\}`, "g"),
        String(v)
      );
    }
  }
  return message;
};

const defaultTPlural = (
  key: string,
  count: number,
  params?: Record<string, string | number>
): string => {
  const suffix = count === 1 ? "one" : "other";
  const pluralKey = `${key}.${suffix}`;
  return defaultT(pluralKey, { ...params, count });
};

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: defaultT,
  tPlural: defaultTPlural,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("locale") as Locale) || "en";
    }
    return "en";
  });

  // Keep `document.documentElement` in sync with the active locale: applied
  // on first paint (so a hard refresh / SSR hydration of an RTL session
  // renders mirrored instead of flashing LTR) and re-applied on change.
  useEffect(() => {
    applyDocumentDirection(locale);
  }, [locale]);

  const handleSetLocale = useCallback((l: Locale) => {
    setLocale(l);
    applyDocumentDirection(l);
    if (typeof window !== "undefined") {
      localStorage.setItem("locale", l);
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let message = get(locales[locale], key) ?? get(locales["en"], key) ?? key;
      if (typeof message !== "string") {
        message = key;
      }
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          message = message.replace(
            new RegExp(`\\{\\{${k}\\}\\}|\\{${k}\\}`, "g"),
            String(v)
          );
        }
      }
      return message;
    },
    [locale]
  );

  const tPlural = useCallback(
    (
      key: string,
      count: number,
      params?: Record<string, string | number>
    ): string => {
      const suffix = count === 1 ? "one" : "other";
      const pluralKey = `${key}.${suffix}`;
      return t(pluralKey, { ...params, count });
    },
    [t]
  );

  return (
    <I18nContext.Provider
      value={{ locale, setLocale: handleSetLocale, t, tPlural }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
