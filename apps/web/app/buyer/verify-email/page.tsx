"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, MailCheck } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { BrandMark } from "@/components/brand";
import { buyerVerifyEmail } from "@/lib/buyer-auth";

// ─── Inner (useSearchParams requires a Suspense boundary) ─────────────────────

function BuyerVerifyEmailInner() {
  const searchParams = useSearchParams();
  // F3-004 (mirrors reset-password): capture the single-use token once, then
  // strip it from the visible URL — it's kept in state and POSTed in the body.
  const [token] = React.useState(() => searchParams.get("token") ?? "");
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);

  // Deliberately requires the button click — no auto-verify on load. Email
  // security scanners prefetch links (some executing JS); auto-verifying would
  // let a scanner in the victim's inbox "confirm" an account the mailbox owner
  // never created — the exact takeover this flow exists to block.
  const onVerify = async () => {
    setApiError(null);
    setSubmitting(true);
    try {
      await buyerVerifyEmail(token);
      setDone(true);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not verify your email. The link may have expired.";
      setApiError(typeof msg === "string" ? msg : "Could not verify your email.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <BrandMark size={48} />
          <h1 className="text-2xl font-bold text-navy">Verify your email</h1>
        </div>

        <div className="rounded-xl bg-white p-6 shadow-card">
          {!token ? (
            <div className="flex flex-col gap-3 text-center">
              <p className="text-sm text-navy">
                This verification link is invalid or incomplete. Sign in to your portal to request a
                new one.
              </p>
              <Link
                href="/buyer/login"
                className="text-sm font-medium text-buyer-600 hover:underline"
              >
                Go to sign in
              </Link>
            </div>
          ) : done ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2 className="h-8 w-8 text-buyer-600" />
              <p className="text-sm font-medium text-navy">Email verified</p>
              <p className="text-sm text-navy/70">
                Sellers who have this email on file can now connect you instantly.
              </p>
              <Link
                href="/buyer/portal"
                className="mt-1 text-sm font-medium text-buyer-600 hover:underline"
              >
                Go to your portal
              </Link>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-2 text-center">
              {apiError && (
                <p className="w-full rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                  {apiError}
                </p>
              )}
              <MailCheck className="h-8 w-8 text-buyer-600" />
              <p className="text-sm text-navy/70">
                Confirm this is your email address. If you didn&apos;t create a RouteFlow buyer
                account, close this page — don&apos;t verify.
              </p>
              <Button onClick={onVerify} loading={submitting} className="w-full">
                Verify my email
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerVerifyEmailPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerVerifyEmailInner />
    </React.Suspense>
  );
}
