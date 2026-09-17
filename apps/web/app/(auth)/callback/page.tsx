"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { OP_KEYS } from "@/lib/auth-keys";
import { setOpPresenceCookie } from "@/lib/presence-cookies";

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
      setOpPresenceCookie();
      // Restore the tenant cookie so API calls include the right X-Tenant-Slug header
      if (tenantSlug) {
        setTenantCookie(tenantSlug);
      }
      // Full document navigation (NOT router.replace): the root AuthProvider only
      // reads localStorage on mount, so a client-side navigation would leave it
      // unauthenticated and the dashboard guard would bounce the user back to
      // login on the first attempt (requiring a second "Sign in with Google"
      // click). A hard load remounts the provider so it reads the stored token.
      window.location.replace("/");
    } else {
      setError("Google sign-in failed. Please try again.");
      setTimeout(() => router.replace("/login?error=google_failed"), 2000);
    }
  }, [params, router]);

  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-4"
      style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
        style={{
          background: "linear-gradient(140deg, #234a74f5, #10264ded)",
          boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
        }}
      >
        RF
      </div>
      {error ? (
        <p className="text-sm text-red-300">{error}</p>
      ) : (
        <p className="text-sm text-[#c2d0e5]">Signing you in...</p>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div
          className="flex h-screen flex-col items-center justify-center gap-4"
          style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
        >
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
            style={{
              background: "linear-gradient(140deg, #234a74f5, #10264ded)",
              boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
            }}
          >
            RF
          </div>
          <p className="text-sm text-[#c2d0e5]">Signing you in...</p>
        </div>
      }
    >
      <AuthCallbackInner />
    </React.Suspense>
  );
}
