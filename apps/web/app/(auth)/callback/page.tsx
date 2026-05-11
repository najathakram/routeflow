"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { OP_KEYS } from "@/lib/auth-keys";

// This page handles the redirect after Google OAuth completes.
// The API redirects here with ?accessToken=...&refreshToken=...&role=...
// We store the tokens in localStorage (same as the regular login flow) and
// redirect to the dashboard.
//
// useSearchParams() requires a Suspense boundary to prevent static generation
// failures during next build (Next.js 14 requirement).

function AuthCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    const tenantSlug = params.get("tenantSlug");

    if (accessToken && refreshToken) {
      // Store tokens under both the namespaced keys (read by AuthProvider /
      // getStoredUser) and the legacy keys (read by any unmigrated code).
      localStorage.setItem(OP_KEYS.accessToken, accessToken);
      localStorage.setItem(OP_KEYS.refreshToken, refreshToken);
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
      // Set the operator presence cookie so middleware path guards work.
      document.cookie = `rf-op-auth=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
      // Restore the tenant cookie so API calls include the right X-Tenant-Slug header
      if (tenantSlug) {
        setTenantCookie(tenantSlug);
      }
      // Navigate to dashboard — the AuthProvider will pick up the stored token
      router.replace("/");
    } else {
      setError("Google sign-in failed. Please try again.");
      setTimeout(() => router.replace("/login?error=google_failed"), 2000);
    }
  }, [params, router]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-raised">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white">
        RF
      </div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <p className="text-sm text-navy/60">Signing you in...</p>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-raised">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white">
            RF
          </div>
          <p className="text-sm text-navy/60">Signing you in...</p>
        </div>
      }
    >
      <AuthCallbackInner />
    </React.Suspense>
  );
}
