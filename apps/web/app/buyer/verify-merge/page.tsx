"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle, XCircle, Loader2, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { useAccountLinkToken } from "@/lib/account-link-token";

// Fixed copy only: the page never displays server text.
const MERGE_VERIFIED_COPY = "Your account ownership is confirmed.";
const MERGE_FAILED_COPY = "We could not verify this link. It may be invalid or have expired.";
const MERGE_MISSING_COPY = "This verification link is invalid or incomplete.";

function VerifyMergeContent() {
  // The single-use token arrives in the URL fragment (`#t=`; legacy `?token=` for links emailed
  // before the change). It is read once, scrubbed from the address bar and POSTed in the body —
  // never placed in a request URL, never logged.
  const { token, ready } = useAccountLinkToken("buyerMerge");

  const [status, setStatus] = React.useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = React.useState("");

  // The token is single-use: React strict mode's double effect run must not POST it twice.
  const posted = React.useRef(false);

  React.useEffect(() => {
    if (!ready || posted.current) return;
    posted.current = true;
    if (!token) {
      setStatus("error");
      setMessage(MERGE_MISSING_COPY);
      return;
    }

    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";
    fetch(`${apiBase}/buyer/auth/verify-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("verify-merge failed");
        setStatus("success");
        setMessage(MERGE_VERIFIED_COPY);
      })
      .catch(() => {
        setStatus("error");
        setMessage(MERGE_FAILED_COPY);
      });
  }, [token, ready]);

  // The shell owns the page heading: it announces the state the card is showing,
  // exactly as the old page's own per-state heading did (MED-1).
  const title =
    status === "success"
      ? "Account Verified!"
      : status === "error"
        ? "Verification Failed"
        : "Verifying...";

  return (
    <AuthShell audience="retailer" kicker="Retailer account" title={title}>
      <div className="text-center">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-brand-500" />
            <p className="mt-2 text-sm text-navy/70">Please wait while we confirm your account.</p>
          </>
        )}

        {status === "success" && (
          <div className="rf-auth-success">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success-bg">
              <CheckCircle className="h-9 w-9 text-success" />
            </div>
            <p className="mt-2 text-sm text-navy/70">{message}</p>
            <div className="mt-6 rounded-lg bg-surface-raised p-4">
              <div className="flex items-start gap-3 text-left">
                <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-500" />
                <p className="text-xs text-navy/70">
                  A platform admin will review the merge request and complete it shortly. Both
                  account owners will receive an email confirmation when it&apos;s done.
                </p>
              </div>
            </div>
            <Link
              href="/buyer/login"
              className="rf-btn mt-6 inline-flex items-center justify-center"
            >
              Go to Login
            </Link>
          </div>
        )}

        {status === "error" && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-danger-bg">
              <XCircle className="h-9 w-9 text-danger" />
            </div>
            <p className="mt-2 text-sm text-navy/70">{message}</p>
            <p className="mt-4 text-xs text-navy/70">
              If your verification link expired, please log in and submit a new merge request from
              Account Settings.
            </p>
            <Link
              href="/buyer/login"
              className="rf-btn mt-6 inline-flex items-center justify-center"
            >
              Go to Login
            </Link>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function VerifyMergePage() {
  return <VerifyMergeContent />;
}
