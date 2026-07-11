"use client";

import * as React from "react";

/**
 * Shared "Continue with Google" plumbing. The operator login page, the buyer
 * login page, and the session-expiry re-auth sheet all initiate the same flow:
 * GET {api}/auth/google?context=…&tenant=… → { url } → full-page redirect to
 * Google consent. The tenant slug rides server-side in the OAuth state param;
 * the web callback page (/auth/google/callback) finishes the sign-in.
 */

export function apiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`
      : "http://localhost:3000/api/v1")
  );
}

export type GoogleStartResult =
  | { ok: true }
  | {
      ok: false;
      reason: "workspace_required" | "not_configured" | "unavailable";
      /** Server-provided 503 message, when present. */
      serverMessage?: string;
    };

/**
 * Kick off Google sign-in. On success the document navigates away (full-page
 * redirect) and this never observably returns — callers should leave their
 * loading state on. On failure it resolves with a mappable reason.
 */
export async function startGoogleSignIn(opts: {
  context: "staff" | "buyer-standalone";
  tenantSlug?: string;
}): Promise<GoogleStartResult> {
  try {
    const params = new URLSearchParams({ context: opts.context });
    if (opts.context !== "buyer-standalone") {
      const tenant = (opts.tenantSlug ?? "").trim().toLowerCase();
      if (!tenant) return { ok: false, reason: "workspace_required" };
      params.set("tenant", tenant);
    }
    const res = await fetch(`${apiBaseUrl()}/auth/google?${params}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.status === 503) {
        return { ok: false, reason: "not_configured", serverMessage: body.message };
      }
      return { ok: false, reason: "unavailable" };
    }
    const data = (await res.json()) as { url?: string };
    if (!data?.url) return { ok: false, reason: "unavailable" };
    window.location.href = data.url;
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
