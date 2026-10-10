"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { roundMoney } from "@routeflow/pricing";
import { MoneyInput } from "@/components/MoneyInput";
import { fmt } from "@/lib/formatting";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_NOTE_ERROR_COPY,
  creditNoteErrorCopy,
  refusalCopy,
} from "@/lib/credit-note-error-copy";
import { useInvoice } from "@/lib/api/invoices";
import {
  type CreditNote,
  useReissueCreditNote,
  useUpdateCreditNote,
  useVoidPreview,
} from "@/lib/api/credit-notes";

/** YYYY-MM-DD for an <input type="date">, from an ISO timestamp (the note's calendar date). */
function toDateInput(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** A fresh Idempotency-Key per opened dialog (SA-535b): a retry of the same edit is a replay. */
function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * #2648 / SA-535(c): Edit a credit note. Reason and expiry are a plain in-place save (PATCH).
 * Changing the amount, or a line's amount on a line-linked note, is never in place: it confirms
 * "This voids CN-X and issues a new credit note" (plus what it un-applies, from void-preview),
 * then reissues and opens the new note.
 */
export function EditCreditNoteModal({
  open,
  onClose,
  note,
}: {
  open: boolean;
  onClose: () => void;
  note: CreditNote;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const update = useUpdateCreditNote();
  const reissue = useReissueCreditNote();

  const lines = React.useMemo(
    () =>
      (note.items ?? []).filter(
        (i): i is typeof i & { invoiceItemId: string } => !!i.invoiceItemId,
      ),
    [note.items],
  );
  const lineLinked = lines.length > 0;
  const { data: invoice } = useInvoice(lineLinked ? (note.invoiceId ?? "") : "");
  const describe = (invoiceItemId: string) =>
    invoice?.items?.find((it) => it.id === invoiceItemId)?.description ?? "Invoice line";

  const [reason, setReason] = React.useState(note.reason ?? "");
  const [expiry, setExpiry] = React.useState(toDateInput(note.expiresAt));
  const [amount, setAmount] = React.useState<number | null>(Number(note.amount));
  const [lineAmounts, setLineAmounts] = React.useState<Record<string, number | null>>({});
  const [confirming, setConfirming] = React.useState(false);
  const [key, setKey] = React.useState(newKey);

  // Reset from the note every time the dialog opens; a new open is a new edit (new key).
  React.useEffect(() => {
    if (!open) return;
    setReason(note.reason ?? "");
    setExpiry(toDateInput(note.expiresAt));
    setAmount(Number(note.amount));
    setLineAmounts(Object.fromEntries(lines.map((l) => [l.invoiceItemId, Number(l.amount)])));
    setConfirming(false);
    setKey(newKey());
  }, [open, note, lines]);

  const newAmount = lineLinked
    ? roundMoney(lines.reduce((s, l) => s + Number(lineAmounts[l.invoiceItemId] ?? 0), 0))
    : roundMoney(Number(amount ?? 0));
  const moneyChanged = lineLinked
    ? lines.some(
        (l) =>
          roundMoney(Number(lineAmounts[l.invoiceItemId] ?? 0)) !== roundMoney(Number(l.amount)),
      )
    : newAmount !== roundMoney(Number(note.amount));
  const reasonChanged = reason.trim() !== (note.reason ?? "").trim();
  const expiryChanged = expiry !== toDateInput(note.expiresAt);
  // A reason that was set can be changed but not blanked (the pre-edit UI always required one).
  // The same guards as mobile: a changed expiry on a non-ISSUED note (when the amount is not changing) or
  // a past date would only be refused by the server, so block it here with the fixed copy.
  const expiryLocked = expiryChanged && !moneyChanged && note.status !== "ISSUED";
  const expiryPast = expiryChanged && !!expiry && new Date(expiry).getTime() <= Date.now();
  const reasonBlanked = reasonChanged && reason.trim() === "" && (note.reason ?? "").trim() !== "";
  // Same convention as the create form (credit-notes/page.tsx): the picked calendar date, as ISO.
  const expiryIso = expiry ? new Date(expiry).toISOString() : null;
  const invalidAmount =
    !(newAmount > 0) ||
    (lineLinked && lines.some((l) => !((lineAmounts[l.invoiceItemId] ?? 0) > 0)));

  const preview = useVoidPreview(note.id, open && confirming);

  const saveInPlace = () => {
    if (!reasonChanged && !expiryChanged) return onClose();
    update.mutate(
      {
        id: note.id,
        ...(reasonChanged ? { reason: reason.trim() } : {}),
        ...(expiryChanged ? { expiresAt: expiryIso } : {}),
      },
      {
        onSuccess: () => {
          toast({ title: "Credit note updated", variant: "success" });
          onClose();
        },
        onError: (err) =>
          toast({
            title: "Couldn't save the credit note",
            description: creditNoteErrorCopy(err, "Please try again."),
            variant: "error",
          }),
      },
    );
  };

  const doReissue = () => {
    reissue.mutate(
      {
        id: note.id,
        idempotencyKey: key,
        amount: newAmount,
        ...(lineLinked
          ? {
              items: lines.map((l) => ({
                invoiceItemId: l.invoiceItemId,
                amount: roundMoney(Number(lineAmounts[l.invoiceItemId] ?? 0)),
              })),
            }
          : {}),
        ...(reasonChanged ? { reason: reason.trim() } : {}),
        ...(expiryChanged ? { expiresAt: expiryIso } : {}),
      },
      {
        onSuccess: (res) => {
          toast({
            title: `${res.voided.creditNoteNumber} replaced by ${res.creditNote.creditNoteNumber}`,
            description: "The new credit note is not applied to any invoice yet.",
            variant: "success",
          });
          onClose();
          router.push(`/credit-notes/${res.creditNote.id}`);
        },
        onError: (err) => {
          setConfirming(false);
          toast({
            title: "Couldn't change the amount",
            description: creditNoteErrorCopy(err, "Nothing was changed. Please try again."),
            variant: "error",
          });
        },
      },
    );
  };

  const onSave = () => (moneyChanged ? setConfirming(true) : saveInPlace());
  const busy = update.isPending || reissue.isPending;

  if (confirming) {
    const unapply = preview.data?.invoices ?? [];
    return (
      <Modal
        open={open}
        onClose={busy ? () => undefined : () => setConfirming(false)}
        title="Change the credit amount?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Back
            </Button>
            <Button
              variant="danger"
              onClick={doReissue}
              loading={reissue.isPending}
              disabled={
                preview.isLoading ||
                preview.isError ||
                !!preview.data?.refusal ||
                !!preview.data?.refusalCode
              }
            >
              Void and issue new
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-navy">
          <p data-testid="reissue-confirm-text">
            This voids {note.creditNoteNumber} and issues a new credit note for{" "}
            <span className="font-semibold">{fmt(newAmount)}</span>
            {unapply.length > 0 && (
              <>
                {" "}
                and un-applies{" "}
                {unapply.map((u, i) => (
                  <span key={u.invoiceId}>
                    {i > 0 ? ", " : ""}
                    {fmt(Number(u.amount))} from {u.invoiceNumber}
                  </span>
                ))}
              </>
            )}
            .
          </p>
          <p className="text-navy/70">
            The new credit note starts unapplied. Apply it again where it belongs.
          </p>
          {preview.isError && (
            <p role="alert" data-testid="reissue-preview-error" className="text-danger">
              We couldn&apos;t check what this change affects. Go back and try again.
            </p>
          )}
          {(preview.data?.refusalCode || preview.data?.refusal) && (
            <p
              role="alert"
              data-testid="reissue-refusal"
              className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-danger"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {refusalCopy(preview.data?.refusalCode)}
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={`Edit ${note.creditNoteNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            loading={update.isPending}
            disabled={invalidAmount || reasonBlanked || expiryLocked || expiryPast || busy}
          >
            {moneyChanged ? "Continue" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {lineLinked ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-navy">Credit per invoice line</legend>
            {lines.map((l) => (
              <div key={l.invoiceItemId} className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`cn-line-${l.invoiceItemId}`}
                  className="min-w-0 truncate text-sm text-navy/80"
                >
                  {describe(l.invoiceItemId)}
                </label>
                <MoneyInput
                  id={`cn-line-${l.invoiceItemId}`}
                  className="w-32"
                  value={lineAmounts[l.invoiceItemId] ?? null}
                  onChange={(v) => setLineAmounts((m) => ({ ...m, [l.invoiceItemId]: v }))}
                />
              </div>
            ))}
            <p className="flex justify-between border-t border-surface-border pt-2 text-sm">
              <span className="text-navy/70">Credit amount</span>
              <span className="font-semibold text-navy">{fmt(newAmount)}</span>
            </p>
          </fieldset>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="cn-edit-amount" className="text-sm font-medium text-navy">
              Credit amount
            </label>
            <MoneyInput id="cn-edit-amount" value={amount} onChange={setAmount} />
          </div>
        )}
        {moneyChanged && (
          <p className="text-xs text-navy/70">
            Changing the amount voids {note.creditNoteNumber} and issues a new credit note.
          </p>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor="cn-edit-reason" className="text-sm font-medium text-navy">
            Reason
          </label>
          <textarea
            id="cn-edit-reason"
            aria-invalid={reasonBlanked || undefined}
            aria-describedby={reasonBlanked ? "cn-edit-reason-hint" : undefined}
            rows={2}
            value={reason}
            maxLength={450}
            onChange={(e) => setReason(e.target.value)}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {reasonBlanked && (
            <p
              id="cn-edit-reason-hint"
              role="alert"
              className="text-xs text-danger"
              data-testid="cn-edit-reason-required"
            >
              A reason is required.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cn-edit-expiry" className="text-sm font-medium text-navy">
            Expires
          </label>
          <input
            id="cn-edit-expiry"
            type="date"
            value={expiry}
            disabled={note.status !== "ISSUED" && !moneyChanged && !expiryChanged}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/50"
          />
          <p className="text-xs text-navy/60">Leave empty for no expiry.</p>
          {(expiryLocked || expiryPast) && (
            <p role="alert" className="text-xs text-danger" data-testid="cn-edit-expiry-hint">
              {
                CREDIT_NOTE_ERROR_COPY[
                  expiryLocked
                    ? API_ERROR_CODES.CREDIT_NOTE_EXPIRY_NOT_EDITABLE
                    : API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST
                ]
              }
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
