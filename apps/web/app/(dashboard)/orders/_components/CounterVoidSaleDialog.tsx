"use client";

// SA-762r (Web-1): the "Void sale" confirm on a Today's-sales row. Own file so CounterTodaysSales takes one mount line.
// The reason is required (audit). Every figure shown comes from the SERVER's `handBack`; nothing is added up here. Every
// refusal is fixed copy chosen by `body.code` (lib/counter-void-error.ts), never the server's text.
import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import { API_ERROR_CODES, staffMay, type CounterSaleVoidResponse } from "@routeflow/types";
import { useOptionalAuth } from "@/lib/auth-context";
import { useVoidCounterSale } from "@/lib/api/counter-sale";
import {
  COUNTER_VOID_ERROR_COPY,
  VOID_REASON_MAX,
  cleanVoidReason,
  handBackLines,
  voidReasonProblem,
} from "@/lib/counter-void-copy";
import { counterVoidErrorCopy, voidErrorCode } from "@/lib/counter-void-error";

type Done = { handBack: CounterSaleVoidResponse["handBack"] | null; alreadyVoided: boolean };

export function CounterVoidSaleDialog({
  open,
  orderId,
  orderNumber,
  onClose,
  onVoided,
}: {
  open: boolean;
  orderId: string;
  orderNumber: string;
  onClose: () => void;
  /** the sale is voided (a fresh void, a repeat, or one already voided): the sheet refetches so the row reads Voided */
  onVoided: () => void;
}) {
  const voidSale = useVoidCounterSale();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState<Done | null>(null);
  const reasonProblem = voidReasonProblem(reason);

  const close = () => {
    if (voidSale.isPending) return;
    setReason("");
    setTouched(false);
    setError("");
    setDone(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (voidSale.isPending || done) return;
    setTouched(true);
    if (reasonProblem) return;
    setError("");
    try {
      const res = await voidSale.mutateAsync({ orderId, reason: cleanVoidReason(reason) });
      setDone({ handBack: res.handBack, alreadyVoided: res.replayed === true });
      onVoided();
    } catch (err) {
      if (voidErrorCode(err) === API_ERROR_CODES.COUNTER_SALE_VOIDED) {
        // dead already (voided earlier, or cancelled in the office): the row must read Voided; no amounts are known
        setDone({ handBack: null, alreadyVoided: true });
        onVoided();
        return;
      }
      setError(counterVoidErrorCopy(err));
    }
  };

  const lines = done ? handBackLines(done.handBack) : [];
  return (
    <Modal
      open={open}
      onClose={close}
      title={`Void sale ${orderNumber}`}
      className="max-w-md"
      footer={
        done ? (
          <Button className="min-h-11" onClick={close}>
            Done
          </Button>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={voidSale.isPending}
              onClick={close}
            >
              Keep sale
            </Button>
            <Button
              type="submit"
              form="counter-void-form"
              variant="danger"
              className="min-h-11"
              disabled={voidSale.isPending}
            >
              {voidSale.isPending ? "Voiding" : "Void sale"}
            </Button>
          </div>
        )
      }
    >
      {done ? (
        <div role="status" className="space-y-2 text-sm" data-testid="counter-void-done">
          <p className="font-semibold">
            {done.handBack === null
              ? COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_VOIDED]
              : done.alreadyVoided
                ? "This sale was already voided."
                : "Sale voided."}
          </p>
          {lines.length > 0 ? (
            <p data-testid="counter-void-handback">{lines.join(" · ")}</p>
          ) : done.handBack !== null ? (
            <p data-testid="counter-void-handback">Nothing to give back.</p>
          ) : null}
        </div>
      ) : (
        <form id="counter-void-form" className="space-y-3 text-sm" onSubmit={submit} noValidate>
          <p>
            This cancels the sale, puts its items back in stock and voids its payments. You
            can&apos;t undo this.
          </p>
          <label className="block">
            Reason for voiding
            <textarea
              aria-label="Reason for voiding"
              aria-invalid={touched && reasonProblem ? true : undefined}
              className="mt-1 min-h-[88px] w-full rounded border px-3 py-2"
              maxLength={VOID_REASON_MAX}
              value={reason}
              disabled={voidSale.isPending}
              onChange={(e) => {
                setReason(e.target.value);
                setError("");
              }}
            />
          </label>
          {touched && reasonProblem ? (
            <p role="alert" className="text-red-700">
              {reasonProblem}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-red-700" data-testid="counter-void-error">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}

/**
 * The row's "Void sale" button. Rendered only for a role that may void (`staffMay(role, "VOID_SALE")`) on a sale that is not
 * voided yet; Today's sales lists only the tenant's current day, so every row is same-day (the server still judges the
 * window: COUNTER_SALE_VOID_NOT_TODAY). The DIALOG lives at the sheet level, not here: a successful void refetches the list,
 * the row becomes Voided and drops this button, and the hand-back the clerk must read would vanish with it.
 */
export function CounterVoidSaleAction({
  orderNumber,
  onOpen,
}: {
  orderNumber: string;
  onOpen: () => void;
}) {
  const role = useOptionalAuth()?.user?.role;
  if (!staffMay(role, "VOID_SALE")) return null;
  return (
    <button
      type="button"
      className="min-h-11 inline-flex items-center justify-center rounded border border-red-300 px-3 text-sm text-red-700"
      aria-label={`Void sale ${orderNumber}`}
      onClick={onOpen}
    >
      Void sale
    </button>
  );
}
