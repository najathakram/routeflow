"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import { creditNoteErrorCopy, refusalCopy } from "@/lib/credit-note-error-copy";
import { useVoidPreview, useVoidWithReversal } from "@/lib/api/credit-notes";

/**
 * #2418 U1 / SA-436 PR-2: void a credit note AFTER un-applying it everywhere. It shows what the
 * void reopens (from void-preview), takes an optional reason for the audit (#2540), and posts
 * void-with-reversal. Every refusal is FIXED copy chosen by code; a server message is never shown.
 */
export function VoidCreditNoteDialog({
  open,
  onClose,
  noteId,
  noteNumber,
}: {
  open: boolean;
  onClose: () => void;
  noteId: string;
  noteNumber: string;
}) {
  const { toast } = useToast();
  const preview = useVoidPreview(noteId, open);
  const voidIt = useVoidWithReversal();
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const reopened = preview.data?.invoices ?? [];
  const refused = !!(preview.data?.refusalCode || preview.data?.refusal);

  const confirm = () =>
    voidIt.mutate(
      { id: noteId, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          onClose();
          toast({
            title: "Credit note voided",
            description: `${noteNumber} has been voided.`,
            variant: "info",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't void the credit note",
            description: creditNoteErrorCopy(err, "Nothing was changed. Please try again."),
            variant: "error",
          }),
      },
    );

  return (
    <Modal
      open={open}
      onClose={voidIt.isPending ? () => undefined : onClose}
      title="Void credit note?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={voidIt.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={confirm}
            loading={voidIt.isPending}
            disabled={preview.isLoading || preview.isError || refused}
          >
            Void credit note
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-navy">
        <p data-testid="void-confirm-text">
          This voids {noteNumber}. It can no longer be applied.
          {reopened.length > 0 && (
            <>
              {" "}
              It first un-applies{" "}
              {reopened.map((u, i) => (
                <span key={u.invoiceId}>
                  {i > 0 ? ", " : ""}
                  {fmt(Number(u.amount))} from {u.invoiceNumber}
                </span>
              ))}
              , which reopens {reopened.length === 1 ? "that invoice" : "those invoices"}.
            </>
          )}
        </p>
        {preview.isError && (
          <p
            role="alert"
            data-testid="void-preview-error"
            className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-danger"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            We couldn&apos;t check what this void affects. Close this window and try again.
          </p>
        )}
        {refused && (
          <p
            role="alert"
            data-testid="void-refusal"
            className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-danger"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {refusalCopy(preview.data?.refusalCode)}
          </p>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-navy/60">
            Reason (optional)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            maxLength={500}
            rows={2}
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm"
            data-testid="void-reason"
          />
        </label>
      </div>
    </Modal>
  );
}
