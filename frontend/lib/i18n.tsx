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

const locales: Record<Locale, Record<string, any>> = { en, es, fr };

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

  const handleSetLocale = useCallback((l: Locale) => {
    setLocale(l);
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
