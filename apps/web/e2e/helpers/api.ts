import type { Page } from "@playwright/test";

/**
 * Direct-API helpers for specs that call the API service outside the page
 * (cleanup, seeding checks). Mirrors the conventions 06-critical-paths.spec.ts
 * established for its API-layer float scans.
 */

/**
 * The API service ORIGIN derived from the current web URL (the API runs on a
 * separate Railway service). Uses SMOKE_BASE_URL when provided, else swaps the
 * web host for the api host. MUST return an origin only — `new URL().origin`
 * strips the page path so callers can append `/api/v1/...` without doubling it.
 */
export function apiBase(webURL: string): string {
  if (process.env.SMOKE_BASE_URL) return process.env.SMOKE_BASE_URL;
  const origin = (() => {
    try {
      return new URL(webURL).origin;
    } catch {
      return webURL;
    }
  })();
  return origin
    .replace(/:3001\b/, ":3000")
    .replace("routeflowweb-production", "routeflowapi-production")
    .replace("routeflowmobile-production", "routeflowapi-production");
}

/**
 * The operator JWT the web app stored at login (both the namespaced and the
 * legacy key, like 06-critical-paths reads it). Empty string when absent —
 * callers should skip their API work rather than send an unauthenticated call.
 */
export async function operatorAccessToken(page: Page): Promise<string> {
  return page
    .evaluate(
      () => localStorage.getItem("rf:op:accessToken") || localStorage.getItem("accessToken") || "",
    )
    .catch(() => "");
}
