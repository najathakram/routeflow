"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { Button, Input } from "@routeflow/ui/web";
import { sendAccountStatementEmail } from "@/lib/api/account-statement";
import { STATEMENT_COPY, sentToLabel } from "@/lib/account-statement-display";
import { useReadOnlyGate } from "@/lib/read-only-gate";

/**
 * SA-1078 PR-4: Email in the statement sheet's footer. One tap opens "Send to", prefilled with the address on file (empty
 * when there is none, or only an import placeholder, so the person is asked); Send posts the address the field shows.
 * The server renders once and says where it went. A failed send keeps the typed address; a double tap is one send. While the
 * workspace is read-only the button is disabled with the shared line (Print still works).
 *
 * Rendered as a fragment into the footer's flex row: the form and the status lines take the full width at the end.
 */
const looksLikeAddress = (v: string): boolean => /^\S+@\S+\.\S+$/.test(v.trim());

type Problem = string | null;

function problemOf(e: unknown): Problem {
  const data = (e as { response?: { data?: { code?: string; message?: string } } })?.response?.data;
  if (data?.code === "EMAIL_NOT_CONFIGURED") return STATEMENT_COPY.emailNotSetUp;
  // EMAIL_SEND_FAILED carries the transport's reason; a 400 on the address carries the validator's.
  return data?.message || STATEMENT_COPY.emailFailed;
}

export function StatementEmailButton({
  customerId,
  emailOnFile,
}: {
  customerId: string;
  emailOnFile: string | null;
}) {
  const gate = useReadOnlyGate();
  const hintId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(emailOnFile ?? "");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState<{ to: string; warning?: string } | null>(null);
  const [problem, setProblem] = React.useState<Problem>(null);
  // A second tap in the same tick sees the state before React has re-rendered it as busy.
  const inFlight = React.useRef(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const to = address.trim();
    if (inFlight.current || !looksLikeAddress(to)) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const res = await sendAccountStatementEmail(customerId, to);
      setSent({ to: res.sentTo, ...(res.warning ? { warning: res.warning } : {}) });
      setOpen(false);
    } catch (err) {
      // The form stays open with what was typed, so one tap tries again.
      setProblem(problemOf(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="primary"
        data-testid="statement-email"
        leftIcon={<Mail className="h-4 w-4" aria-hidden />}
        disabled={gate.readOnly}
        aria-describedby={gate.readOnly ? hintId : undefined}
        aria-expanded={open}
        onClick={() => {
          setSent(null);
          setProblem(null);
          setOpen((v) => !v);
        }}
      >
        {STATEMENT_COPY.email}
      </Button>
      {gate.readOnly && gate.line ? (
        <p
          id={hintId}
          data-testid="statement-email-read-only"
          className="order-last w-full text-xs text-navy/70"
        >
          {gate.line}
        </p>
      ) : null}
      {open && !gate.readOnly ? (
        <form
          onSubmit={(e) => void send(e)}
          data-testid="statement-email-form"
          className="order-last flex w-full flex-wrap items-end gap-2"
        >
          <div className="min-w-[12rem] flex-1">
            <Input
              label={STATEMENT_COPY.sendTo}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="max-sm:h-11"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            className="max-sm:min-h-11"
            disabled={busy || !looksLikeAddress(address)}
          >
            {STATEMENT_COPY.send}
          </Button>
        </form>
      ) : null}
      {problem ? (
        <p role="alert" className="order-last w-full text-sm text-danger">
          {problem}
        </p>
      ) : null}
      {sent ? (
        <div role="status" className="order-last w-full text-sm text-navy">
          <p>{sentToLabel(sent.to)}</p>
          {sent.warning ? <p className="text-xs text-navy/70">{sent.warning}</p> : null}
        </div>
      ) : null}
    </>
  );
}
