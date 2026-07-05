"use client";

import * as React from "react";
import { apiClient } from "@/lib/api-client";
import { OP_KEYS } from "@/lib/auth-keys";
import { LOCALES, MESSAGES, type Locale, type MessageKey } from "./messages";

export { LOCALES, LOCALE_LABELS, type Locale } from "./messages";

const STORAGE_KEY = "rf:locale";

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return (LOCALES as readonly string[]).includes(stored ?? "") ? (stored as Locale) : "en";
}

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFn;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>("en");

  // Init from localStorage on the client (avoids SSR/CSR hydration mismatch).
  React.useEffect(() => {
    const initial = readStoredLocale();
    setLocaleState(initial);
    document.documentElement.lang = initial;
  }, []);

  // Reconcile with the server-side per-user preference (cross-device), best
  // effort and only when an operator session exists. Skip on the buyer portal /
  // auth pages so a stale operator token never fires an operator API call there.
  React.useEffect(() => {
    if (!localStorage.getItem(OP_KEYS.accessToken)) return;
    const path = window.location.pathname;
    if (path.startsWith("/buyer") || path === "/login" || path === "/admin-login") return;
    let cancelled = false;
    apiClient
      .get("/users/me/preferences")
      .then((res) => {
        const serverLocale = res.data?.locale;
        if (cancelled || !serverLocale) return;
        if ((LOCALES as readonly string[]).includes(serverLocale)) {
          setLocaleState(serverLocale as Locale);
          window.localStorage.setItem(STORAGE_KEY, serverLocale);
          document.documentElement.lang = serverLocale;
        }
      })
      .catch(() => {
        /* preferences are optional; ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next;
    // Persist per-user (cross-device); best effort.
    if (localStorage.getItem(OP_KEYS.accessToken)) {
      apiClient.patch("/users/me/preferences", { locale: next }).catch(() => {});
    }
  }, []);

  const t = React.useCallback<TFn>(
    (key, vars) => {
      const template = MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) =>
        name in vars ? String(vars[name]) : `{${name}}`,
      );
    },
    [locale],
  );

  const value = React.useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}
