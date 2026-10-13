"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, ShieldCheck, Users } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { buyerVerifyMerge } from "@/lib/buyer-auth";

// useSearchParams() requires Suspense — force dynamic rendering to avoid
// Next.js static-generation export error at build time.
export const dynamic = "force-dynamic";

function VerifyMergeContent() {
  const params = useSearchParams();
  // Mirrors buyer/verify-email: capture the single-use token once, then strip it
  // from the visible URL — it's kept in state and POSTed in the body on confirm.
  const [token] = React.useState(() => params.get("token"));
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const [status, setStatus] = React.useState<"confirm" | "loading" | "success" | "error">(
    token ? "confirm" : "error",
  );
  const [message, setMessage] = React.useState(token ? "" : "No verification token provided.");
  const inFlight = React.useRef(false);
  // The result region is a polite live region that is always mounted, so confirm -> loading ->
  // success/error is announced as a content change. The confirm button unmounts on a result, so
  // focus moves to the region (tabIndex -1) rather than falling back to <body>; only after a
  // click, so a no-token failure on load never steals focus.
  const resultRef = React.useRef<HTMLDivElement>(null);
  const clicked = React.useRef(false);
  React.useEffect(() => {
    if (clicked.current && (status === "success" || status === "error")) {
      resultRef.current?.focus();
    }
  }, [status]);

  // Row 404: deliberately requires the button click — nothing is sent on load.
  // Mail scanners and link prefetchers open emailed links (some run JS); an
  // auto-confirm would let one complete the merge before the owner ever saw it.
  const onConfirm = async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    clicked.current = true;
    setStatus("loading");
    try {
      await buyerVerifyMerge(token);
      setStatus("success");
      setMessage("Your account ownership is confirmed.");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
      setStatus("error");
      setMessage(typeof msg === "string" && msg ? msg : "Verification failed.");
    } finally {
      inFlight.current = false;
    }
  };

  // The shell owns the page heading: it announces the state the card is showing,
  // exactly as the old page's own per-state heading did (MED-1).
  const title =
    status === "success"
      ? "Account Verified!"
      : status === "error"
        ? "Verification Failed"
        : status === "loading"
          ? "Verifying..."
          : "Confirm account merge";

  return (
    <AuthShell audience="retailer" kicker="Retailer account" title={title}>
      <div
        ref={resultRef}
        role="status"
        aria-live="polite"
        aria-busy={status === "loading"}
        tabIndex={-1}
        className="text-center focus:outline-none"
      >
        {(status === "confirm" || status === "loading") && (
          <div className="flex flex-col items-center gap-4 py-2">
            <Users className="h-8 w-8 text-brand-500" />
            <p className="text-sm text-navy/70">
              Confirm that you own this retailer account and want it merged into another RouteFlow
              account. If you didn&apos;t ask for this, close this page — nothing changes until you
              confirm.
            </p>
            <Button onClick={onConfirm} loading={status === "loading"} className="rf-btn w-full">
              Confirm account merge
            </Button>
          </div>
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
  return (
    <React.Suspense fallback={null}>
      <VerifyMergeContent />
    </React.Suspense>
  );
}
