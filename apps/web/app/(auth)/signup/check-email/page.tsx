"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Mail, RefreshCw, XCircle } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { isWorkspaceId } from "@/lib/last-workspace";
import { site } from "@/app/(marketing)/lib/site";
import {
  RESEND_FAILED_COPY,
  RESEND_SENT_COPY,
  requestVerificationResend,
} from "@/lib/resend-verification";

// ─── Inner page ───────────────────────────────────────────────────────────────

function CheckEmailInner() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  // Set by the signup page when POST /public/tenants/register reported the
  // verification email did NOT go out (mail transport failure) — the account
  // still exists, but there is nothing in the inbox to click yet.
  const initialSendFailed = params.get("emailSent") === "false";
  // W2 B1: sign-in asks for the Workspace ID typed. The signup page passes it along; text that is not
  // shaped like one (a crafted link) is dropped, never shown.
  const rawWorkspace = params.get("workspace") ?? "";
  const workspaceId = isWorkspaceId(rawWorkspace) ? rawWorkspace : null;

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
    // The endpoint is enumeration-safe (see lib/resend-verification): a non-2xx or a network
    // failure proves something went wrong; a 2xx does not prove delivery.
    const r = await requestVerificationResend(email);
    setResendFailed(r === "failed");
    setResendMsg(r === "sent" ? RESEND_SENT_COPY : RESEND_FAILED_COPY);
    setResending(false);
  };

  return (
    <AuthShell
      audience="distributor"
      kicker="Distributor account"
      title={title}
      footer={
        <>
          <a
            href="/login"
            className="flex items-center justify-center gap-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
          >
            Back to sign in
          </a>
          <p className="text-xs text-navy/70">
            Wrong email?{" "}
            <a href="/signup" className="text-brand-600 hover:underline">
              Sign up again
            </a>{" "}
            with a new Workspace ID, or email{" "}
            <a href={`mailto:${site.email}`} className="text-brand-600 hover:underline">
              {site.email}
            </a>
            .
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

        {workspaceId && (
          <div className="mt-5 rounded-lg border border-surface-border bg-white px-4 py-3 text-center">
            <p className="text-xs text-navy/70">Your Workspace ID</p>
            <p className="mt-1 font-mono text-base font-semibold text-navy">{workspaceId}</p>
            <p className="mt-1 text-xs text-navy/70">You&apos;ll need it to sign in.</p>
          </div>
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
