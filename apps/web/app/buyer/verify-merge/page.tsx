"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, Loader2, ShieldCheck } from "lucide-react";

// useSearchParams() requires Suspense — force dynamic rendering to avoid
// Next.js static-generation export error at build time.
export const dynamic = "force-dynamic";

function VerifyMergeContent() {
  const params = useSearchParams();
  const token = params.get("token");

  const [status, setStatus] = React.useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";
    fetch(`${apiBase}/buyer/auth/verify-merge/${token}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.message ?? "Verification failed");
        setStatus("success");
        setMessage(data.message ?? "Your account ownership is confirmed.");
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Verification failed.");
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised px-4">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-white p-8 shadow-sm text-center">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-brand-500" />
            <h1 className="text-xl font-bold text-navy">Verifying...</h1>
            <p className="mt-2 text-sm text-navy/70">Please wait while we confirm your account.</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success-bg">
              <CheckCircle className="h-9 w-9 text-success" />
            </div>
            <h1 className="text-xl font-bold text-navy">Account Verified!</h1>
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
              className="mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Go to Login
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-danger-bg">
              <XCircle className="h-9 w-9 text-danger" />
            </div>
            <h1 className="text-xl font-bold text-navy">Verification Failed</h1>
            <p className="mt-2 text-sm text-navy/70">{message}</p>
            <p className="mt-4 text-xs text-navy/70">
              If your verification link expired, please log in and submit a new merge request from
              Account Settings.
            </p>
            <Link
              href="/buyer/login"
              className="mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Go to Login
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyMergePage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-raised">
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
        </div>
      }
    >
      <VerifyMergeContent />
    </React.Suspense>
  );
}
