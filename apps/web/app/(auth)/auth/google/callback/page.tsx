"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ─── Error messages shown to the user ────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  state_invalid:
    "Sign-in could not be completed. The link may have expired — please try again.",
  unauthorized:
    "Your Google account is not authorized for this system. Contact your administrator.",
  tenant_suspended:
    "This account is currently suspended. Please contact support.",
  google_email_is_staff:
    "This email is registered as a staff account. Please sign in from the staff login page instead.",
  oauth_cancelled: "Sign-in was cancelled. Please try again.",
  unknown_error: "An unexpected error occurred. Please try again.",
};

// ─── Inner component (requires Suspense for useSearchParams) ─────────────────

function GoogleCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = React.useState<"loading" | "error">("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    const type = params.get("type"); // "BUYER" or absent (staff)
    const role = params.get("role"); // OPERATOR, DRIVER, CUSTOMER, TENANT_ADMIN
    const tenantSlug = params.get("tenantSlug");
    const sellerCount = params.get("sellerCount");
    const linked = params.get("linked");
    const error = params.get("error");

    // ── Error path ──────────────────────────────────────────────────────────
    if (error) {
      const msg = ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown_error;
      setErrorMsg(msg);
      setErrorCode(error);
      setStatus("error");

      // Auto-redirect for transient errors
      if (error === "state_invalid" || error === "oauth_cancelled" || error === "unknown_error") {
        setTimeout(() => router.replace("/login?error=google_failed"), 4000);
      }
      return;
    }

    // ── Success path ─────────────────────────────────────────────────────────
    if (!accessToken || !refreshToken) {
      setErrorMsg(ERROR_MESSAGES.unknown_error);
      setErrorCode("unknown_error");
      setStatus("error");
      setTimeout(() => router.replace("/login?error=google_failed"), 4000);
      return;
    }

    if (type === "BUYER") {
      // Store buyer tokens (same keys as regular buyer login)
      localStorage.setItem("buyerAccessToken", accessToken);
      localStorage.setItem("buyerRefreshToken", refreshToken);
      // Redirect to buyer portal — show linked banner if just accepted an invite
      const destination = linked === "true" ? "/buyer/portal?linked=true" : "/buyer/portal";
      router.replace(destination);
    } else {
      // Store staff tokens (same keys as regular staff login)
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);

      // Restore tenant cookie so API calls include X-Tenant-Slug header
      if (tenantSlug) {
        const maxAge = 60 * 60 * 24 * 30; // 30 days
        document.cookie = `tenant-slug=${encodeURIComponent(tenantSlug)}; path=/; max-age=${maxAge}; samesite=lax`;
      }

      // Role-based post-login destination
      if (role === "CUSTOMER") {
        router.replace("/dashboard"); // Customers see limited dashboard view
      } else {
        router.replace("/dashboard");
      }
    }
  }, [params, router]);

  // ── Loading spinner ────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-raised">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
          style={{ backgroundColor: "#3B82F6" }}
        >
          RF
        </div>
        <p className="text-sm text-navy/60">Signing you in…</p>
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  // ── Error display ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-surface-raised p-4">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
        style={{ backgroundColor: "#3B82F6" }}
      >
        RF
      </div>

      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-card text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-bg mx-auto">
          <svg className="h-5 w-5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>

        <h2 className="text-base font-semibold text-navy mb-2">Sign-in failed</h2>
        <p className="text-sm text-navy/70 mb-4">{errorMsg}</p>

        {/* Contextual actions per error type */}
        {errorCode === "google_email_is_staff" ? (
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-lg border border-surface-border bg-white px-4 py-2 text-sm font-medium text-navy shadow-sm hover:bg-surface-raised transition-colors"
          >
            Go to staff login
          </a>
        ) : errorCode === "unauthorized" || errorCode === "tenant_suspended" ? (
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
          >
            Back to login
          </a>
        ) : (
          <p className="text-xs text-navy/50">Redirecting you back in a moment…</p>
        )}
      </div>
    </div>
  );
}

// ─── Page export (with Suspense for useSearchParams) ─────────────────────────

export default function GoogleCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-raised">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
            style={{ backgroundColor: "#3B82F6" }}
          >
            RF
          </div>
          <p className="text-sm text-navy/60">Signing you in…</p>
        </div>
      }
    >
      <GoogleCallbackInner />
    </React.Suspense>
  );
}
