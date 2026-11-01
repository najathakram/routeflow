"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { Button, Input, useToast } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { sendAccountStatementEmail } from "@/lib/api/account-statement";
import { STATEMENT_COPY, sentToLabel } from "@/lib/account-statement-display";
import { useReadOnlyGate } from "@/lib/read-only-gate";

/**
 * SA-1078 PR-4: Email in the statement sheet's footer. One tap opens "Send to", prefilled with the address on file (empty
 * when there is none, or only an import placeholder, so the person is asked); Send posts the address the field shows.
 * The server renders once and says where it went. A failed send keeps the typed address; a double tap is one send, even if the
 * sheet is closed and reopened mid-send (the guard lives at module level, per customer), and a failure after the sheet closed
 * is a toast. While the workspace is read-only the button is disabled with the shared line (Print still works).
 *
 * Rendered as a fragment into the footer's flex row: the form and the status lines take the full width at the end.
 */
const looksLikeAddress = (v: string): boolean => /^\S+@\S+\.\S+$/.test(v.trim());

type Problem = string | null;

/** Customers with a send in flight. Module level on purpose: closing the sheet unmounts the button, the request goes on. */
const sending = new Map<string, Promise<void>>();

function problemOf(e: unknown): string {
  const data = (e as { response?: { data?: { code?: string; message?: unknown } } })?.response
    ?.data;
  if (data?.code === API_ERROR_CODES.EMAIL_NOT_CONFIGURED) return STATEMENT_COPY.emailNotSetUp;
  // A coded refusal (EMAIL_SEND_FAILED) carries the transport's reason in words. A 400 with no code is the validator's raw
  // text ("email must be an email", often an array): the person reads the plain sentence instead.
  if (data?.code && typeof data.message === "string" && data.message) return data.message;
  return STATEMENT_COPY.emailFailed;
}

export function StatementEmailButton({
  customerId,
  emailOnFile,
}: {
  customerId: string;
  emailOnFile: string | null;
}) {
  const gate = useReadOnlyGate();
  const { toast } = useToast();
  const hintId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(emailOnFile ?? "");
  const [busy, setBusy] = React.useState(() => sending.has(customerId));
  const [sent, setSent] = React.useState<{ to: string; warning?: string } | null>(null);
  const [problem, setProblem] = React.useState<Problem>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    // Reopened while a send from the closed sheet is still running: stay busy until it ends.
    const running = sending.get(customerId);
    if (running) {
      setBusy(true);
      void running.then(() => alive.current && setBusy(false));
    }
    return () => {
      alive.current = false;
    };
  }, [customerId]);

  async function post(to: string) {
    try {
      const res = await sendAccountStatementEmail(customerId, to);
      if (!alive.current) return;
      setSent({ to: res.sentTo, ...(res.warning ? { warning: res.warning } : {}) });
      setOpen(false);
    } catch (err) {
      // Open sheet: the form stays open with what was typed, so one tap tries again. Closed sheet: nobody is looking at it.
      if (alive.current) setProblem(problemOf(err));
      else
        toast({
          title: STATEMENT_COPY.emailFailedTitle,
          description: problemOf(err),
          variant: "error",
        });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const to = address.trim();
    // A second tap in the same tick sees the state before React has re-rendered it as busy; the map is set before any await.
    if (sending.has(customerId) || !looksLikeAddress(to)) return;
    setBusy(true);
    setProblem(null);
    sending.set(
      customerId,
      post(to).finally(() => sending.delete(customerId)),
    );
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
          onSubmit={send}
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
