"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, MailCheck } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { buyerVerifyEmail } from "@/lib/buyer-auth";
import { useAccountLinkToken } from "@/lib/account-link-token";

// Fixed copy only: a failed verification never shows server text.
const VERIFY_FAILED_COPY = "Could not verify your email. The link may have expired.";

function BuyerVerifyEmailInner() {
  // The single-use token arrives in the URL fragment (`#t=`; legacy `?token=` for links emailed
  // before the change). It is read once, scrubbed from the address bar, kept in memory and
  // POSTed in the body — never re-read from the URL, never logged.
  const { token, ready } = useAccountLinkToken("buyerVerifyEmail");
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
    } catch {
      setApiError(VERIFY_FAILED_COPY);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) return null;

  return (
    <AuthShell audience="retailer" kicker="Retailer account" title="Confirm your email.">
      {!token ? (
        <div className="flex flex-col gap-3 text-center">
          <p className="text-sm text-navy">
            This verification link is invalid or incomplete. Sign in to your portal to request a new
            one.
          </p>
          <Link href="/buyer/login" className="text-sm font-medium text-[#0B6E6B] hover:underline">
            Go to sign in
          </Link>
        </div>
      ) : done ? (
        <div className="rf-auth-success flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="h-8 w-8 text-buyer-600" />
          <p className="text-sm font-medium text-navy">Email verified</p>
          <p className="text-sm text-navy/70">
            Sellers who have this email on file can now connect you instantly.
          </p>
          <Link
            href="/buyer/portal"
            className="mt-1 text-sm font-medium text-[#0B6E6B] hover:underline"
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
            Confirm this is your email address. If you didn&apos;t create a RouteFlow buyer account,
            close this page — don&apos;t verify.
          </p>
          <Button onClick={onVerify} loading={submitting} className="rf-btn w-full">
            Verify my email
          </Button>
        </div>
      )}
    </AuthShell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerVerifyEmailPage() {
  return <BuyerVerifyEmailInner />;
}
