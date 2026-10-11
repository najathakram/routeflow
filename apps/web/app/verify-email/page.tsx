"use client";

import * as React from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { adoptTokenPair } from "@/lib/auth";
import { useAccountLinkToken } from "@/lib/account-link-token";

// ─── States ───────────────────────────────────────────────────────────────────

type VerifyState = "verifying" | "success" | "error";

// ─── Copy ─────────────────────────────────────────────────────────────────────

// Fixed copy only: a failed verification never shows server text.
const NO_TOKEN_COPY = "No verification token found. Please use the link from your email.";
const FAILED_COPY =
  "This link is invalid, has expired or was already used. If you have already verified your email, sign in.";
const NETWORK_COPY = "Something went wrong. Please try again.";

// ─── Inner page ───────────────────────────────────────────────────────────────

function VerifyEmailInner() {
  // The single-use token arrives in the URL fragment (`#t=`; the legacy `?token=` form only for
  // links emailed before the change). It is read once, scrubbed from the address bar, kept in
  // memory and POSTed in the body: never re-read from the URL and never logged.
  const { token, ready } = useAccountLinkToken("staffVerifyEmail");

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [state, setState] = React.useState<VerifyState>("verifying");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // The link is single-use, so the POST must go out exactly once per page load, even when React
  // strict mode runs the effect twice in development. `mounted` (not a per-run flag) tells the
  // in-flight request whether anything is still on screen to update.
  const started = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    if (!token) {
      setState("error");
      setErrorMsg(NO_TOKEN_COPY);
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${apiUrl}/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (!mounted.current) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if ((body as { code?: string }).code === "ALREADY_VERIFIED") {
            // Already verified: nothing to do here but sign in the normal way.
            window.location.replace("/login");
            return;
          }
          setState("error");
          setErrorMsg(FAILED_COPY);
          return;
        }

        const data = await res.json();

        // The SAME post-login step as password login and the in-app handoff (#2653):
        // namespaced operator keys, presence cookie, impersonation reset, tenant cookie.
        adoptTokenPair(data);

        setState("success");

        // Brief pause to show success state, then a FULL document navigation:
        // the root AuthProvider only reads localStorage on mount, so a client-side
        // router.push would leave it unauthenticated and the dashboard AuthGuard
        // would bounce straight to /login (same constraint as (auth)/callback).
        setTimeout(() => {
          if (mounted.current) window.location.replace("/dashboard");
        }, 1500);
      } catch {
        if (mounted.current) {
          setState("error");
          setErrorMsg(NETWORK_COPY);
        }
      }
    })();
  }, [token, ready, apiUrl]);

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
  return <VerifyEmailInner />;
}
