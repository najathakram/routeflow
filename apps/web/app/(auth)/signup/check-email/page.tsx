"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Mail, ArrowLeft, RefreshCw } from "lucide-react";

// ─── Inner page ───────────────────────────────────────────────────────────────

function CheckEmailInner() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [resending, setResending] = React.useState(false);
  const [resendMsg, setResendMsg] = React.useState<string | null>(null);

  const handleResend = async () => {
    if (!email || resending) return;
    setResending(true);
    setResendMsg(null);
    try {
      await fetch(`${apiUrl}/public/tenants/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setResendMsg("Sent! Check your inbox (and spam folder).");
    } catch {
      setResendMsg("Something went wrong. Please try again in a moment.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="rounded-xl bg-white p-8 shadow-card text-center">
          {/* Icon */}
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <Mail className="h-8 w-8 text-brand-600" />
          </div>

          <h1 className="text-xl font-bold text-navy">Check your inbox</h1>
          <p className="mt-3 text-sm text-navy/60 leading-relaxed">
            We sent a verification link to{" "}
            {email ? (
              <strong className="text-navy">{email}</strong>
            ) : (
              "your email address"
            )}
            . Click the link to activate your account and get started.
          </p>

          <div className="mt-6 rounded-lg bg-surface-raised px-4 py-3 text-left text-xs text-navy/60 space-y-1">
            <p className="font-medium text-navy">Didn't receive it?</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>Check your spam or junk folder</li>
              <li>Make sure you entered the right email</li>
              <li>The link expires in 24 hours</li>
            </ul>
          </div>

          {/* Resend */}
          <div className="mt-5">
            {resendMsg ? (
              <p className="text-sm text-success">{resendMsg}</p>
            ) : (
              <button
                onClick={handleResend}
                disabled={resending || !email}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-surface-border px-4 py-2.5 text-sm font-medium text-navy/70 transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
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
            )}
          </div>
        </div>

        {/* Back links */}
        <div className="mt-6 space-y-2 text-center">
          <a
            href="/login"
            className="flex items-center justify-center gap-1.5 text-xs text-navy/50 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-3 w-3" /> Back to Sign In
          </a>
          <p className="text-xs text-navy/40">
            Wrong email?{" "}
            <a href="/signup" className="text-brand-600 hover:underline">
              Sign up again
            </a>
          </p>
        </div>
      </div>
    </div>
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
