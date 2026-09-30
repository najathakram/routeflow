"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Mail, RefreshCw, XCircle } from "lucide-react";
import { AuthShell } from "@/components/auth";

// ─── Inner page ───────────────────────────────────────────────────────────────

function CheckEmailInner() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  // Set by the signup page when POST /public/tenants/register reported the
  // verification email did NOT go out (mail transport failure) — the account
  // still exists, but there is nothing in the inbox to click yet.
  const initialSendFailed = params.get("emailSent") === "false";

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [resending, setResending] = React.useState(false);
  const [resendMsg, setResendMsg] = React.useState<string | null>(null);
  const [resendFailed, setResendFailed] = React.useState(false);

  // The frame must read as a problem, not a success, when the account was
  // created but the verification email itself never went out — a mint
  // "Check your inbox" heading over a failure message told the user to check
  // an inbox that has nothing in it (fix-round visual review, PR #778).
  const title = initialSendFailed ? "We couldn't send your email" : "Check your inbox";

  const handleResend = async () => {
    if (!email || resending) return;
    setResending(true);
    setResendMsg(null);
    setResendFailed(false);
    try {
      // The endpoint is deliberately enumeration-safe: it always returns 200
      // with the same body whether or not the address is registered, so a
      // 2xx here does NOT prove delivery for a real account — but a non-2xx
      // or a network failure DOES prove something went wrong, and previously
      // this branch was never checked at all (the button always claimed
      // success even when the request itself failed).
      const res = await fetch(`${apiUrl}/public/tenants/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setResendFailed(true);
        setResendMsg("Something went wrong. Please try again in a moment.");
        return;
      }
      setResendMsg("If that address has a pending account, a new link is on its way.");
    } catch {
      setResendFailed(true);
      setResendMsg("Something went wrong. Please try again in a moment.");
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthShell
      audience="distributor"
      kicker="Distributor workspace"
      title={title}
      footer={
        <>
          <a
            href="/login"
            className="flex items-center justify-center gap-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
          >
            Back to Sign In
          </a>
          <p className="text-xs text-navy/70">
            Wrong email?{" "}
            <a href="/signup" className="text-brand-600 hover:underline">
              Sign up again
            </a>
          </p>
        </>
      }
    >
      <div
        className={
          initialSendFailed
            ? "rf-auth-success rf-auth-success--danger text-center"
            : "rf-auth-success text-center"
        }
      >
        {/* Icon — danger tone (same XCircle/bg-danger pattern as the
            verify-email error state) when the send itself failed, so the icon
            never contradicts the heading above it. */}
        {initialSendFailed ? (
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-danger/10">
            <XCircle className="h-8 w-8 text-danger" />
          </div>
        ) : (
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <Mail className="h-8 w-8 text-brand-600" />
          </div>
        )}

        {initialSendFailed ? (
          <p className="text-sm text-danger leading-relaxed">
            Your account was created, but we couldn&apos;t send the verification email to{" "}
            {email ? <strong>{email}</strong> : "your address"} just now — our mail service may be
            temporarily unavailable. Use the button below to try again in a minute, or contact
            support if it keeps failing.
          </p>
        ) : (
          <p className="text-sm text-navy/70 leading-relaxed">
            We sent a verification link to{" "}
            {email ? <strong className="text-navy">{email}</strong> : "your email address"}. Click
            the link to activate your account and get started.
          </p>
        )}

        <div className="mt-6 rounded-lg bg-surface-raised px-4 py-3 text-left text-xs text-navy/70 space-y-1">
          <p className="font-medium text-navy">Didn&apos;t receive it?</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Check your spam or junk folder</li>
            <li>Make sure you entered the right email</li>
            <li>The link expires in 24 hours</li>
          </ul>
        </div>

        {/* Resend */}
        <div className="mt-5">
          {resendMsg && !resendFailed ? (
            <p className="text-sm text-success">{resendMsg}</p>
          ) : (
            <>
              {resendMsg && resendFailed && <p className="mb-2 text-sm text-danger">{resendMsg}</p>}
              <button
                onClick={handleResend}
                disabled={resending || !email}
                className="rf-btn secondary flex w-full items-center justify-center gap-2"
              >
                {resending ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4" />
                    Resend verification email
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </AuthShell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CheckEmailPage() {
  return (
    <React.Suspense fallback={null}>
      <CheckEmailInner />
    </React.Suspense>
  );
}
