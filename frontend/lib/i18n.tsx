/**
 * lib/i18n.tsx — Lightweight i18n context with JSON locale files, pluralization, and interpolation.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import fr from "@/locales/fr.json";

export type Locale = "en" | "es" | "fr";
const supportedLocales: readonly Locale[] = ["en", "es", "fr"];
const locales: Record<Locale, Record<string, any>> = { en, es, fr };

export function normalizeLocale(locale?: string | null): Locale {
  const candidate = locale?.trim().toLowerCase();
  if (!candidate) return "en";

  const base = candidate.split("-")[0];
  return supportedLocales.includes(base as Locale) ? (base as Locale) : "en";
}

function getPluralSuffix(locale: Locale, count: number): "one" | "other" {
  const rule = new Intl.PluralRules(locale).select(count);
  return rule === "one" ? "one" : "other";
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
  const pluralKey = `${key}.${getPluralSuffix("en", count)}`;
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
      const stored = localStorage.getItem("locale");
      const browserLocale = navigator.language;
      return normalizeLocale(stored ?? browserLocale ?? "en");
    }
    return "en";
  });

  const handleSetLocale = useCallback((l: Locale) => {
    const nextLocale = normalizeLocale(l);
    setLocale(nextLocale);
    if (typeof window !== "undefined") {
      localStorage.setItem("locale", nextLocale);
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const activeLocale = normalizeLocale(locale);
      let message =
        get(locales[activeLocale], key) ?? get(locales["en"], key) ?? key;
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
      const pluralKey = `${key}.${getPluralSuffix(normalizeLocale(locale), count)}`;
      return t(pluralKey, { ...params, count });
    },
    [locale, t]
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
