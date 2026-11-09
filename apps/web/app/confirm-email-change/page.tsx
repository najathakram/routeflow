"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, Mail } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { emailChangeRefusalCopy } from "@/lib/email-change-copy";

// B461 (SA-1116): the page the link in the NEW address's mail opens. Opening it sends nothing: a mail scanner that
// prefetches the link must not confirm the change (the row-404 rule of the account-merge page). The person taps the
// button, which POSTs the single-use token in the body and shows the coded answer, never the server's text. Phones
// open it in the web shell: there is no native screen.

type ConfirmState = "ready" | "confirming" | "success" | "error";

function ConfirmEmailChangeInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [state, setState] = React.useState<ConfirmState>(token ? "ready" : "error");
  const [email, setEmail] = React.useState<string | null>(null);
  const [errorCopy, setErrorCopy] = React.useState<string>(
    token ? "" : emailChangeRefusalCopy(undefined),
  );

  const confirm = async () => {
    if (!token || state === "confirming") return;
    setState("confirming");
    try {
      const res = await fetch(`${apiUrl}/auth/confirm-email-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: unknown; email?: unknown };
      if (!res.ok) {
        setErrorCopy(emailChangeRefusalCopy(body.code));
        setState("error");
        return;
      }
      setEmail(typeof body.email === "string" ? body.email : null);
      setState("success");
    } catch {
      setErrorCopy("Something went wrong. Try again.");
      setState("error");
    }
  };

  const title =
    state === "success"
      ? "Email updated"
      : state === "error"
        ? "Couldn't confirm the email"
        : "Confirm your new email";

  return (
    <AuthShell audience="distributor" kicker="Distributor account" title={title}>
      <div className="text-center">
        {(state === "ready" || state === "confirming") && (
          <>
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
              {state === "confirming" ? (
                <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
              ) : (
                <Mail className="h-8 w-8 text-brand-600" />
              )}
            </div>
            <p className="mt-2 text-sm text-navy/70">
              Use this address as your RouteFlow login email.
            </p>
            <div className="mt-6">
              <button
                type="button"
                className="rf-btn flex w-full items-center justify-center"
                disabled={state === "confirming"}
                onClick={confirm}
              >
                Confirm this address
              </button>
            </div>
          </>
        )}

        {state === "success" && (
          <div className="rf-auth-success">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <p className="mt-2 text-sm text-navy/70">
              {email ? `Your login email is now ${email}.` : "Your login email is updated."} Use it
              the next time you sign in.
            </p>
            <div className="mt-6">
              <a href="/login" className="rf-btn flex w-full items-center justify-center">
                Continue to sign in
              </a>
            </div>
          </div>
        )}

        {state === "error" && (
          <>
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-danger/10">
              <XCircle className="h-8 w-8 text-danger" />
            </div>
            <p className="mt-2 text-sm text-navy/70">{errorCopy}</p>
            <div className="mt-6">
              <a href="/login" className="rf-btn secondary flex w-full items-center justify-center">
                Back to sign in
              </a>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function ConfirmEmailChangePage() {
  return (
    <React.Suspense fallback={null}>
      <ConfirmEmailChangeInner />
    </React.Suspense>
  );
}
