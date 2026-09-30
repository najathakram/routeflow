"use client";

import { useEffect } from "react";

/** Initializes Sentry in the browser ONLY when NEXT_PUBLIC_SENTRY_DSN is set.
 *
 * `release` tags every browser event with the deployed commit sha so Sentry can group issues
 * per-release for release-health comparisons (scripts/release-health.mjs). Client components
 * only ever see `NEXT_PUBLIC_*` vars, and those are baked into the JS bundle at `next build`
 * time (see apps/web/Dockerfile) — RAILWAY_GIT_COMMIT_SHA itself is proven only at container
 * RUNTIME (apps/web/app/api/health/route.ts), not at build time, so NEXT_PUBLIC_RELEASE_SHA is
 * a separate build arg wired through the Dockerfile, sourced from a Railway service variable
 * referencing `${{RAILWAY_GIT_COMMIT_SHA}}` (see apps/web/.env.example). An unset value is
 * `undefined` here (never a blank string), which Sentry.init() accepts fine — it never crashes
 * boot, it just leaves the event untagged.
 */
export function SentryInit() {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;
    void import("@sentry/react").then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        release: process.env.NEXT_PUBLIC_RELEASE_SHA || undefined,
      });
      const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
      if (match) Sentry.setTag("tenant", decodeURIComponent(match[1]));
    });
  }, []);
  return null;
}
