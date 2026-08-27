"use client";

import { useEffect } from "react";

/** Initializes Sentry in the browser ONLY when NEXT_PUBLIC_SENTRY_DSN is set. */
export function SentryInit() {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;
    void import("@sentry/react").then((Sentry) => {
      Sentry.init({ dsn, environment: process.env.NODE_ENV });
      const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
      if (match) Sentry.setTag("tenant", decodeURIComponent(match[1]));
    });
  }, []);
  return null;
}
