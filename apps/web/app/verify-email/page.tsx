"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { OP_KEYS } from "@/lib/auth-keys";
import { setOpPresenceCookie } from "@/lib/presence-cookies";

// ─── States ───────────────────────────────────────────────────────────────────

type VerifyState = "verifying" | "success" | "error";

// ─── Inner page ───────────────────────────────────────────────────────────────

function VerifyEmailInner() {
  const params = useSearchParams();

  const token = params.get("token");

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [state, setState] = React.useState<VerifyState>("verifying");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) {
      setState("error");
      setErrorMsg("No verification token found. Please use the link from your email.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${apiUrl}/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (cancelled) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            (body as { message?: string }).message ??
            "Verification failed. The link may have expired.";
          setState("error");
          setErrorMsg(msg);
          return;
        }

        const data = await res.json();

        // Store tokens exactly like the normal login flow (lib/auth.ts login):
        // the namespaced operator keys — everything (api-client, getStoredUser)
        // reads only these; the legacy "accessToken"/"refreshToken" keys are dead.
        localStorage.setItem(OP_KEYS.accessToken, data.accessToken);
        localStorage.setItem(OP_KEYS.refreshToken, data.refreshToken);
        // Presence cookie for the middleware guards — without it a browser that
        // also holds a buyer session gets bounced off /dashboard to /buyer/portal.
        setOpPresenceCookie();

        // Set tenant cookie so the API interceptor sends the right tenant header
        if (data.user?.tenantSlug) {
          setTenantCookie(data.user.tenantSlug);
        }

        setState("success");

        // Brief pause to show success state, then a FULL document navigation:
        // the root AuthProvider only reads localStorage on mount, so a client-side
        // router.push would leave it unauthenticated and the dashboard AuthGuard
        // would bounce straight to /login (same constraint as (auth)/callback).
        setTimeout(() => {
          if (!cancelled) window.location.replace("/dashboard");
        }, 1500);
      } catch {
        if (!cancelled) {
          setState("error");
          setErrorMsg("Something went wrong. Please try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, apiUrl]);

  // The shell owns the page heading: it announces the state the card is showing,
  // exactly as the old page's own per-state heading did (MED-1).
  const title =
    state === "success"
      ? "Email verified!"
      : state === "error"
        ? "Verification failed"
        : "Verifying your email…";

  return (
    <AuthShell audience="distributor" kicker="Distributor workspace" title={title}>
      <div className="text-center">
        {/* Verifying */}
        {state === "verifying" && (
          <>
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
              <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
            </div>
            <p className="mt-2 text-sm text-navy/70">
              Just a moment while we activate your account.
            </p>
          </>
        )}

        {/* Success */}
        {state === "success" && (
          <div className="rf-auth-success">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <p className="mt-2 text-sm text-navy/70">
              Your account is active. Taking you to your dashboard…
            </p>
            <div className="mt-4 flex justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-navy/30" />
            </div>
          </div>
        )}

        {/* Error */}
        {state === "error" && (
          <>
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-danger/10">
              <XCircle className="h-8 w-8 text-danger" />
            </div>
            <p className="mt-2 text-sm text-navy/70">{errorMsg}</p>
            <div className="mt-6 space-y-3">
              <a href="/signup" className="rf-btn flex w-full items-center justify-center">
                Sign up again
              </a>
              <a href="/login" className="rf-btn secondary flex w-full items-center justify-center">
                Back to Sign In
              </a>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VerifyEmailPage() {
  return (
    <React.Suspense fallback={null}>
      <VerifyEmailInner />
    </React.Suspense>
  );
}
