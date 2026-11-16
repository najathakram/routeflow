"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Input } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { adoptTokenPair } from "@/lib/auth";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  RESEND_FAILED_COPY,
  RESEND_SENT_COPY,
  requestVerificationResend,
} from "@/lib/resend-verification";

// ─── States ───────────────────────────────────────────────────────────────────

type VerifyState = "verifying" | "success" | "error";
type ErrorKind = "expired" | "invalid" | "missing" | "network";

// Fixed copy: the server's message is never rendered (L-178).
const ERROR_COPY: Record<ErrorKind, string> = {
  expired:
    "This link has expired. Links last 24 hours. Enter your email and we'll send you a new one.",
  invalid: "This link didn't work. Enter your email and we'll send you a new one.",
  missing: "No verification token found. Please use the link from your email.",
  network: "Something went wrong. Please try again.",
};

// ─── Inner page ───────────────────────────────────────────────────────────────

function VerifyEmailInner() {
  const params = useSearchParams();

  const token = params.get("token");

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [state, setState] = React.useState<VerifyState>("verifying");
  const [errorKind, setErrorKind] = React.useState<ErrorKind | null>(null);
  const [resendEmail, setResendEmail] = React.useState("");
  const [resendStatus, setResendStatus] = React.useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = resendEmail.trim();
    if (!email || resendStatus === "sending") return;
    setResendStatus("sending");
    setResendStatus(await requestVerificationResend(email));
  };

  React.useEffect(() => {
    if (!token) {
      setState("error");
      setErrorKind("missing");
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
          if ((body as { code?: string }).code === "ALREADY_VERIFIED") {
            // Already verified: nothing to do here but sign in the normal way.
            window.location.replace("/login");
            return;
          }
          setState("error");
          setErrorKind(
            (body as { code?: string }).code === API_ERROR_CODES.VERIFICATION_LINK_EXPIRED
              ? "expired"
              : "invalid",
          );
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
          if (!cancelled) window.location.replace("/dashboard");
        }, 1500);
      } catch {
        if (!cancelled) {
          setState("error");
          setErrorKind("network");
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
      ? "Email verified."
      : state === "error"
        ? errorKind === "expired"
          ? "Link expired"
          : "Verification failed"
        : "Verifying your email…";

  return (
    <AuthShell audience="distributor" kicker="Distributor account" title={title}>
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
            <p className="mt-2 text-sm text-navy/70">{errorKind ? ERROR_COPY[errorKind] : null}</p>
            {resendStatus === "sent" ? (
              <p role="status" className="mt-4 text-sm text-success">
                {RESEND_SENT_COPY}
              </p>
            ) : (
              <form onSubmit={handleResend} className="mt-4 space-y-3 text-left">
                {resendStatus === "failed" && (
                  <p role="alert" className="text-sm text-danger">
                    {RESEND_FAILED_COPY}
                  </p>
                )}
                <Input
                  id="resend-email"
                  label="Email"
                  type="email"
                  required
                  placeholder="you@company.com"
                  autoComplete="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                />
                <div className="grid">
                  <button type="submit" className="rf-btn" disabled={resendStatus === "sending"}>
                    {resendStatus === "sending" ? "Sending…" : "Send a new link"}
                  </button>
                </div>
              </form>
            )}
            <div className="mt-4 space-y-3">
              <a href="/login" className="rf-btn secondary flex w-full items-center justify-center">
                Back to sign in
              </a>
            </div>
            <p className="mt-4 text-sm text-navy/60">
              Need a different email?{" "}
              <a href="/signup" className="underline">
                Sign up again
              </a>
            </p>
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
