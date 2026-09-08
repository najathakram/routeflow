"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Mail, RefreshCw } from "lucide-react";
import { AuthShell } from "@/components/auth";

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
    <AuthShell
      audience="distributor"
      kicker="Distributor workspace"
      title="Check your inbox"
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
      <div className="rf-auth-success text-center">
        {/* Icon */}
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
          <Mail className="h-8 w-8 text-brand-600" />
        </div>

        <p className="text-sm text-navy/70 leading-relaxed">
          We sent a verification link to{" "}
          {email ? <strong className="text-navy">{email}</strong> : "your email address"}. Click the
          link to activate your account and get started.
        </p>

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
          {resendMsg ? (
            <p className="text-sm text-success">{resendMsg}</p>
          ) : (
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
