"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

// This page handles the redirect after Google OAuth completes.
// The API redirects here with ?accessToken=...&refreshToken=...&role=...
// We store the tokens in localStorage (same as the regular login flow) and
// redirect to the dashboard.

export default function AuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");

    if (accessToken && refreshToken) {
      // Store tokens the same way the regular login flow does
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
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
