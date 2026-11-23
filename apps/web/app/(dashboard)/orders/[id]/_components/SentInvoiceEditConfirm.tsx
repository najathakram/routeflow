"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  EDIT_REVERTS_SENT_CONFIRM,
  EDIT_REVERTS_SENT_TITLE,
  editRevertsSentCopy,
} from "@/lib/edit-reverts-sent";

/** B1372 N2: the invoice numbers of a 409 ORDER_EDIT_REVERTS_SENT_INVOICE (the server's own revert set), else null. */
export function sentRevertNumbersOf(err: unknown): string[] | null {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)
    ?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.ORDER_EDIT_REVERTS_SENT_INVOICE)
    return null;
  const numbers = res.data?.invoiceNumbers;
  return Array.isArray(numbers) ? numbers.filter((n): n is string => typeof n === "string") : [];
}

/**
 * B1372 (SA-1177 K2): holds an items save until the staff confirm that it turns an already-sent invoice back into a draft
 * (`numbers` = the order read's `editRevertsSentInvoices`). `ask(save)` returns true when it opened the confirm (the caller
 * stops; "Edit anyway" runs `save`), false when there is nothing to confirm or the staff already confirmed in this editing
 * session (a retry after an error or a restriction confirm is not asked twice). Leaving edit mode (`active` false) resets it.
 *
 * N2 (SA-1177 A2 K3): the server enforces the confirm. `ack()` is spread into the save, so a confirmed save carries
 * `ackSentRevert: true`. An invoice sent after the page was read comes back as a 409 naming it: `capture(err, retry)` opens
 * the same confirm with the server's numbers, and "Edit anyway" retries with the ack. `ownsToast` keeps the global toast off it.
 */
export function useSentInvoiceEditConfirm(numbers: string[] | undefined, active: boolean) {
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const [serverNumbers, setServerNumbers] = React.useState<string[] | null>(null);
  const confirmed = React.useRef(false);
  React.useEffect(() => {
    if (!active) {
      confirmed.current = false;
      setServerNumbers(null);
    }
  }, [active]);
  const description = editRevertsSentCopy(serverNumbers ?? numbers);

  const ask = (save: () => void): boolean => {
    if (!description || confirmed.current) return false;
    setPending(() => save);
    return true;
  };

  const capture = (err: unknown, retry: () => void): boolean => {
    const fromServer = sentRevertNumbersOf(err);
    if (!fromServer) return false;
    confirmed.current = false;
    setServerNumbers(fromServer.length > 0 ? fromServer : null);
    setPending(() => retry);
    return true;
  };

  const ack = (): { ackSentRevert?: true } => (confirmed.current ? { ackSentRevert: true } : {});
  const ownsToast = (err: unknown): boolean => sentRevertNumbersOf(err) !== null;

  const dialog = (
    <ConfirmDialog
      open={pending !== null && !!description}
      onClose={() => setPending(null)}
      onConfirm={() => {
        const save = pending;
        setPending(null);
        confirmed.current = true;
        save?.();
      }}
      title={EDIT_REVERTS_SENT_TITLE}
      description={description ?? undefined}
      confirmLabel={EDIT_REVERTS_SENT_CONFIRM}
      variant="warning"
    />
  );
  return { ask, capture, ack, ownsToast, dialog };
}
