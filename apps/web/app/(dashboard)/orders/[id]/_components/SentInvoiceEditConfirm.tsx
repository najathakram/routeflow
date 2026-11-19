"use client";

import * as React from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  EDIT_REVERTS_SENT_CONFIRM,
  EDIT_REVERTS_SENT_TITLE,
  editRevertsSentCopy,
} from "@/lib/edit-reverts-sent";

/**
 * B1372 (SA-1177 K2): holds an items save until the staff confirm that it turns an already-sent invoice back into a draft
 * (`numbers` = the order read's `editRevertsSentInvoices`). `ask(save)` returns true when it opened the confirm (the caller
 * stops; "Edit anyway" runs `save`), false when there is nothing to confirm or the staff already confirmed in this editing
 * session (a retry after an error or a restriction confirm is not asked twice). Leaving edit mode (`active` false) resets it.
 */
export function useSentInvoiceEditConfirm(numbers: string[] | undefined, active: boolean) {
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const confirmed = React.useRef(false);
  React.useEffect(() => {
    if (!active) confirmed.current = false;
  }, [active]);
  const description = editRevertsSentCopy(numbers);

  const ask = (save: () => void): boolean => {
    if (!description || confirmed.current) return false;
    setPending(() => save);
    return true;
  };

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
  return { ask, dialog };
}
