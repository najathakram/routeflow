"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { roundMoney } from "@routeflow/pricing";
import {
  API_ERROR_CODES,
  RECORD_ANYWAY_LABEL,
  canRecordAnyway,
  creditOverLimitSentence,
  COUNTER_COPY,
} from "@routeflow/types";
import type {
  CounterSalePaymentMethod,
  PickupCompleteResponse,
  ToCollectMethod,
} from "@routeflow/types";
import { usePickupComplete, usePickupInvoiceBalances } from "@/lib/api/counter-sale";
import { useCounterDefaultTender } from "@/lib/api/counter-customer-credit";
import { useOptionalAuth } from "@/lib/auth-context";
import { useRestrictionWarningRetry } from "@/lib/use-restriction-warning-retry";
import { duplicatePaymentRefMessage, retryCanHelp } from "@/lib/duplicate-payment-ref";
import { usePrintInvoice } from "@/lib/use-print-invoice";
import { CheckNotReceivedChoice } from "../../_components/CheckNotReceivedChoice";
import {
  paymentProblemCopy,
  PICKUP_DEAD_INVOICE,
  COMPLETE_HARD_REFUSAL_CODES,
  changeDue,
  clearHeldPickupKey,
  newIdempotencyKey,
  paymentMethodOptions,
  pickupBalanceDue,
  pickupCompleteErrorCopy,
  pickupErrorCode,
  quickTenderOptions,
  readHeldPickupKey,
  isTenderShortCopy,
  tenderShortCopy,
  resolveTender,
  validatePayment,
  writeHeldPickupKey,
} from "@/lib/counter-sale";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** The key of an attempt whose outcome is UNKNOWN, held by the parent across close/reopen, per order. */
export type HeldPickupKey = { orderId: string; key: string } | null;

type Body = {
  payment?: {
    method: CounterSalePaymentMethod;
    amount?: number;
    reference?: string;
    recordAnyway?: boolean;
    /** SA-1026: with ON_ACCOUNT only: "the check is not received yet" (the order is left To collect) */
    expectedMethod?: ToCollectMethod;
  };
  /** SA-913 R8: the confirmed re-send after COUNTER_COMPLETE_ON_RUN (same key) */
  takeOffRun?: boolean;
};

/**
 * "Picked up" on a PICKUP order (order ahead): payment is taken AT pickup. Opening the dialog mints ONE
 * Idempotency-Key that every attempt in it reuses (a retry of a failed or not-recorded payment must be the
 * same hand-over, never a second); closing and reopening mints a new one, EXCEPT after an UNKNOWN outcome
 * (network error / 5xx): the key is then held in `heldKey` (per order) and reused until a known outcome. The tender is the till's: same
 * methods, same rules (`validatePayment`), cash amount + change only for CASH. What is left to collect
 * comes from the order's invoices' server `balanceDue` (no invoice yet = the order total); nothing left =
 * no tender step. The server still judges the real balance.
 */
export function PickupCompleteDialog({
  open,
  onClose,
  orderId,
  orderNumber,
  total,
  invoices,
  isWalkIn,
  customerId = null,
  handOver = false,
  completeMode = false,
  heldKey,
  storeKey = null,
  customerName = null,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber?: string;
  total: number;
  invoices: ReadonlyArray<{ id: string; status: string }>;
  isWalkIn: boolean;
  /** SA-933: the order's customer; their terms set the default tender (Net N is On account). Null/walk-in: Cash. */
  customerId?: string | null;
  /** POS-mode order (PICKUP, not a counter sale): the confirm button reads "Hand over". Counter / portal keep "Picked up". */
  handOver?: boolean;
  /** I-120: "Complete at counter" (any open order): its title, confirm and outcome copy; the payment step is the same. */
  completeMode?: boolean;
  heldKey?: React.MutableRefObject<HeldPickupKey>;
  /** sessionStorage key (tenant + user + order) that keeps an UNKNOWN outcome's key across a reload. */
  storeKey?: string | null;
  /** I-120: the customer the credit-over-limit line names (falls back to "the customer"). */
  customerName?: string | null;
}) {
  const ownHeld = React.useRef<HeldPickupKey>(null);
  const held = heldKey ?? ownHeld;
  const complete = usePickupComplete(orderId);
  const rw = useRestrictionWarningRetry(); // W-775: the staff warning + override dialog (the switch is judged at the store's state)
  const liveIds = invoices.filter((i) => !PICKUP_DEAD_INVOICE.has(i.status)).map((i) => i.id);
  const balances = usePickupInvoiceBalances(liveIds, open);
  const loading = liveIds.length > 0 && balances.isLoading;
  // A failed balance read falls back to the order total: the server never over-collects.
  const balanceDue = loading
    ? null
    : pickupBalanceDue(
        total,
        balances.data ?? (liveIds.length > 0 ? [{ status: "SENT", total }] : []),
      );
  // A balance that appeared at hand-over (server said so) forces the tender step even if the read said paid.
  const [owed, setOwed] = React.useState<number | null>(null);
  const due = owed ?? balanceDue;
  const nothingToCollect = due !== null && due <= 0;
  const qc = useQueryClient();

  const keyRef = React.useRef<string>("");
  const [method, setMethod] = React.useState<CounterSalePaymentMethod>("CASH");
  // SA-933: the same default the till applies, until the cashier chooses (a late-loading read never overrides a choice).
  const defaultTender = useCounterDefaultTender(open && !isWalkIn ? customerId : null);
  const defaultRef = React.useRef(defaultTender);
  defaultRef.current = defaultTender;
  const decidedRef = React.useRef(false);
  const [tendered, setTendered] = React.useState("");
  /** Row 312(b): the value the dialog itself put in the cash field; a different value is the cashier's own. */
  const autoTendered = React.useRef("");
  const [reference, setReference] = React.useState("");
  // SA-1026: "Check not received yet" under Check (named customer): sent as On account + expectedMethod CHECK.
  const [checkNotReceived, setCheckNotReceived] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | undefined>();
  const [errorRunId, setErrorRunId] = React.useState<string | null>(null); // W-778: the run a started stop belongs to
  const [outcome, setOutcome] = React.useState<PickupCompleteResponse | null>(null);
  const lastBody = React.useRef<Body>({});
  // SA-1026 D: "Change check number" returns to the tender with the number field focused.
  const numberRef = React.useRef<HTMLInputElement>(null);
  const [focusNumber, setFocusNumber] = React.useState(0);
  React.useEffect(() => {
    if (focusNumber > 0) numberRef.current?.focus();
  }, [focusNumber]);

  React.useEffect(() => {
    if (open && !decidedRef.current && defaultTender !== null) setMethod(defaultTender);
  }, [open, defaultTender]);

  React.useEffect(() => {
    if (open) {
      if (held.current?.orderId !== orderId) {
        const stored = readHeldPickupKey(storeKey);
        held.current = stored ? { orderId, key: stored } : null;
      }
      keyRef.current = held.current?.orderId === orderId ? held.current.key : newIdempotencyKey();
      decidedRef.current = false;
      setMethod(defaultRef.current ?? "CASH");
      autoTendered.current = "";
      setTendered("");
      setReference("");
      setCheckNotReceived(false);
      setError(null);
      setErrorCode(undefined);
      setErrorRunId(null);
      setOwed(null);
      setOutcome(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Row 312(b): the cash amount starts at the amount due (as Exact sets it), and follows it (a balance the server
  // reported later) until the cashier types. One press fewer on an exact cash hand-over; a typed amount is never replaced.
  React.useEffect(() => {
    if (!open || due === null || due <= 0) return;
    const next = String(roundMoney(due)); // the same string Exact sets (quickTenderOptions)
    setTendered((cur) => {
      if (cur !== autoTendered.current) return cur;
      autoTendered.current = next;
      return next;
    });
  }, [open, due]);

  const tenderedNum = Number(tendered) || 0;
  // W-778 (apple-ux): a refusal no retry can fix locks the controls; the run confirm is a warning the clerk can answer.
  const hardRefusal = errorCode !== undefined && COMPLETE_HARD_REFUSAL_CODES.has(errorCode);
  const onRunWarning = errorCode === API_ERROR_CODES.COUNTER_COMPLETE_ON_RUN;
  // A typed amount re-opens the question: drop the last answer (the stale "Enter at least" line, the run warning).
  const editedTender = () => {
    if (hardRefusal) return;
    setError(null);
    setErrorCode(undefined);
    setErrorRunId(null);
  };

  async function send(body: Body) {
    setError(null);
    setErrorCode(undefined);
    setErrorRunId(null);
    lastBody.current = body;
    try {
      const res = await complete.mutateAsync({
        body: rw.attach(body),
        idempotencyKey: keyRef.current,
      });
      const code = res.paymentRecorded ? undefined : res.paymentErrorCode;
      if (
        code === API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED ||
        code === API_ERROR_CODES.COUNTER_TENDER_SHORT
      ) {
        // Back to the tender step; the next attempt is the same hand-over (same key) carrying the payment.
        if (res.balanceDue > 0) setOwed(res.balanceDue);
        setErrorCode(code);
        setError(
          pickupCompleteErrorCopy({ response: { data: { code } } }, undefined, completeMode),
        );
        return;
      }
      held.current = null;
      clearHeldPickupKey(storeKey);
      setOutcome(res);
    } catch (err) {
      // W-775: a RESTRICTION_WARNING wrote nothing (pre-judged before the claim): the dialog re-sends THIS hand-over, same key
      if (rw.handle(err, () => send(lastBody.current))) return;
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      const unknown = status === undefined || status >= 500;
      held.current = unknown ? { orderId, key: keyRef.current } : null;
      if (unknown) writeHeldPickupKey(storeKey, keyRef.current);
      else clearHeldPickupKey(storeKey);
      setErrorCode(pickupErrorCode(err));
      const runId = (err as { response?: { data?: { runId?: unknown } } } | null)?.response?.data
        ?.runId;
      setErrorRunId(typeof runId === "string" && runId ? runId : null);
      setError(pickupCompleteErrorCopy(err, due ?? undefined, completeMode));
    }
  }

  function reload() {
    void qc.invalidateQueries({ queryKey: ["orders"] });
    onClose();
  }

  function confirm() {
    if (due === null) return;
    if (nothingToCollect) return void send({});
    const tender = resolveTender(method, checkNotReceived);
    const problem = validatePayment({
      method: tender.method,
      total: due,
      tendered: tenderedNum,
      reference,
      isWalkIn,
      fullTenderOnly: true, // SA-933 S4 opened part payment at the counter sale only; this dialog keeps the full-tender rule
    });
    if (problem) return setError(paymentProblemCopy(problem, due));
    void send({
      payment: {
        ...tender,
        ...(tender.method === "CASH" ? { amount: roundMoney(tenderedNum) } : {}),
        // SA-1026: "Check not received yet" sends no number: a typed one is dropped, never deduped
        ...(reference.trim() && !tender.expectedMethod ? { reference: reference.trim() } : {}),
      },
    });
  }

  // W-778 (F12): a cash amount below what is owed says so while it is typed (not only after Complete), and clears the moment it is enough
  const shortLive =
    method === "CASH" &&
    due !== null &&
    tendered.trim() !== "" &&
    roundMoney(tenderedNum) < roundMoney(due) &&
    !(error && isTenderShortCopy(error));
  const unrecorded = outcome !== null && !outcome.paymentRecorded;
  // SA-1026 B: after the hand-over the invoices are issued and numbered, so Print invoice prints the final copies (every non-void invoice of the order, from the response)
  const printInvoice = usePrintInvoice();
  // SA-837b item 3: the payment was refused as a duplicate reference. The shared sentence names the existing payment, and a
  // staff role may resend THIS hand-over (same key, same body) with the generic `payment.recordAnyway` flag.
  const role = (useOptionalAuth()?.user as { role?: string } | null | undefined)?.role;
  const duplicateMessage =
    unrecorded &&
    outcome?.paymentCauseCode === API_ERROR_CODES.DUPLICATE_PAYMENT_REF &&
    outcome.existingPayment
      ? duplicatePaymentRefMessage({
          response: {
            status: 409,
            data: {
              code: API_ERROR_CODES.DUPLICATE_PAYMENT_REF,
              existingPayment: outcome.existingPayment,
            },
          },
        })
      : null;
  const sentPayment = lastBody.current?.payment;
  const recordAnyway = () =>
    void send({ ...lastBody.current, payment: { ...sentPayment!, recordAnyway: true } });
  // SA-1026 D: a duplicate reference can never pass on a retry. Back to the tender (Check, the typed number kept), where the
  // cashier fixes the number or picks "Check not received yet". The dialog keeps its key: the resend is the same hand-over.
  const changeCheckNumber = () => {
    if (outcome && outcome.balanceDue > 0) setOwed(outcome.balanceDue); // the tender step needs a balance to collect
    setOutcome(null);
    setMethod("CHECK");
    setCheckNotReceived(false);
    setReference(sentPayment?.reference ?? reference);
    setError(null);
    setErrorCode(undefined);
    setFocusNumber((n) => n + 1);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${completeMode ? COUNTER_COPY.completeAtCounter : handOver ? "Hand over" : "Picked up"}${orderNumber ? ` ${orderNumber}` : ""}`}
      className="max-w-md"
      footer={
        outcome ? (
          <>
            {unrecorded && retryCanHelp(outcome) && (
              <Button
                variant="secondary"
                type="button"
                loading={complete.isPending}
                onClick={() => void send(lastBody.current)}
              >
                Retry
              </Button>
            )}
            {duplicateMessage && (
              <Button type="button" onClick={changeCheckNumber}>
                Change check number
              </Button>
            )}
            {duplicateMessage && sentPayment && canRecordAnyway(role) && (
              <Button
                variant="secondary"
                type="button"
                loading={complete.isPending}
                onClick={recordAnyway}
              >
                {RECORD_ANYWAY_LABEL}
              </Button>
            )}
            {outcome && !unrecorded && (
              <Button
                variant="secondary"
                type="button"
                disabled={printInvoice.printing}
                onClick={() =>
                  void printInvoice.print(
                    outcome.invoiceIds?.length ? outcome.invoiceIds : [outcome.invoiceId],
                  )
                }
              >
                Print invoice
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            {hardRefusal ? (
              // W-778: nothing was written and nothing here can retry it: one live action
              <Button
                type="button"
                onClick={errorCode === API_ERROR_CODES.ORDER_RUN_LINK_CHANGED ? reload : onClose}
              >
                {errorCode === API_ERROR_CODES.ORDER_RUN_LINK_CHANGED ? "Reload" : "Close"}
              </Button>
            ) : (
              <Button variant="ghost" type="button" disabled={complete.isPending} onClick={onClose}>
                Cancel
              </Button>
            )}
            {/* Both mean the order is already handed over: nothing to retry, only to reload what the page shows. */}
            {hardRefusal ? null : errorCode === API_ERROR_CODES.PICKUP_KEY_CONFLICT ||
              errorCode === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED ? (
              <Button type="button" onClick={reload}>
                Reload
              </Button>
            ) : (
              <>
                {errorCode === API_ERROR_CODES.PICKUP_INVOICE_MISSING && (
                  <Button
                    variant="secondary"
                    type="button"
                    loading={complete.isPending}
                    onClick={() => void send(lastBody.current)}
                  >
                    Retry
                  </Button>
                )}
                {/* SA-913 R8: the order is on a driver's run; the alert names the driver, this re-sends with the confirm */}
                {errorCode === API_ERROR_CODES.COUNTER_COMPLETE_ON_RUN ? (
                  <Button
                    type="button"
                    loading={complete.isPending}
                    onClick={() => void send({ ...lastBody.current, takeOffRun: true })}
                  >
                    {COUNTER_COPY.takeOffRun}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={confirm}
                    loading={complete.isPending}
                    disabled={due === null}
                  >
                    {completeMode
                      ? COUNTER_COPY.completeConfirm
                      : handOver
                        ? "Hand over"
                        : nothingToCollect
                          ? "Confirm picked up"
                          : "Picked up"}
                  </Button>
                )}
              </>
            )}
          </>
        )
      }
    >
      <div className="space-y-4">
        {outcome ? (
          <div className="space-y-2" data-testid="pickup-outcome">
            {outcome.alreadyPickedUp && (
              <p className="text-sm text-navy/70">This order was already picked up.</p>
            )}
            {unrecorded ? (
              <p role="alert" className="text-sm font-semibold text-danger">
                Payment not recorded
              </p>
            ) : (
              <p className="text-sm font-semibold text-navy">
                {completeMode
                  ? outcome.emailed
                    ? COUNTER_COPY.completedEmailed
                    : COUNTER_COPY.completed
                  : outcome.toCollect === "TO_COLLECT" && outcome.balanceDue > 0
                    ? `Picked up. To collect: ${money(outcome.balanceDue)}.`
                    : outcome.balanceDue > 0
                      ? `Picked up. ${money(outcome.balanceDue)} still due.`
                      : "Picked up and paid."}
                {completeMode && outcome.balanceDue > 0
                  ? ` ${money(outcome.balanceDue)} still due.`
                  : ""}
              </p>
            )}
            {unrecorded && (
              <p className="text-xs text-navy/70">
                {duplicateMessage
                  ? "The order is handed over, but the payment was not saved."
                  : "The order is handed over, but the payment was not saved. Retry to record it."}
              </p>
            )}
            {duplicateMessage && <p className="text-sm text-navy">{duplicateMessage}</p>}
            {/* I-120 (SA-849 on the hand-over): the gate counted this tender; without it the customer is over their limit. */}
            {unrecorded && outcome.creditOverLimit && (
              <p
                role="status"
                className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"
                data-testid="pickup-credit-over-limit"
              >
                {creditOverLimitSentence(customerName, outcome.creditOverLimit, money)}
              </p>
            )}
            {(outcome.change ?? 0) > 0 && (
              <p className="text-3xl font-bold" data-testid="pickup-change">
                Change {money(outcome.change ?? 0)}
              </p>
            )}
          </div>
        ) : due === null ? (
          <p className="text-sm text-navy/70">Checking the balance…</p>
        ) : nothingToCollect ? (
          <p className="text-sm font-medium text-navy">Paid — nothing to collect</p>
        ) : (
          <section aria-label="Payment" className="space-y-3">
            <p className="text-sm text-navy">
              Collect <strong>{money(due)}</strong>
            </p>
            <div className="flex flex-wrap gap-2">
              {paymentMethodOptions(isWalkIn, defaultTender)
                .filter((m) => !m.disabled) // a walk-in has no account: On account is not offered at all
                .map((m) => (
                  <button
                    key={m.method}
                    type="button"
                    disabled={m.disabled || hardRefusal}
                    aria-pressed={method === m.method}
                    className={cn(
                      "rounded border px-3 py-2 text-sm disabled:opacity-40",
                      method === m.method && "border-brand-600 bg-brand-50 font-semibold",
                    )}
                    onClick={() => {
                      decidedRef.current = true;
                      setMethod(m.method);
                      setCheckNotReceived(false); // the choice belongs to Check
                      editedTender();
                    }}
                  >
                    {m.label}
                  </button>
                ))}
            </div>
            {method === "CASH" && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {quickTenderOptions(due).map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      disabled={q.disabled || hardRefusal}
                      className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                      onClick={() => {
                        decidedRef.current = true;
                        setTendered(String(q.amount));
                        editedTender();
                      }}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
                <label className="block text-sm">
                  Amount tendered
                  <input
                    aria-label="Amount tendered"
                    inputMode="decimal"
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={tendered}
                    disabled={hardRefusal}
                    onChange={(e) => {
                      decidedRef.current = true; // typed money is a decision: a late default never flips the tender
                      setTendered(e.target.value);
                      editedTender();
                    }}
                  />
                </label>
                {hardRefusal ? null : shortLive ? (
                  <p className="text-sm font-medium text-navy" data-testid="pickup-short-hint">
                    {tenderShortCopy(due)}
                  </p>
                ) : (
                  <p className="text-2xl font-bold" data-testid="pickup-change-due">
                    Change {money(changeDue(due, tenderedNum))}
                  </p>
                )}
              </div>
            )}
            {method === "CHECK" && !checkNotReceived && (
              <label className="block text-sm">
                Check number
                <input
                  aria-label="Check number"
                  ref={numberRef}
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={reference}
                  disabled={hardRefusal}
                  onChange={(e) => {
                    decidedRef.current = true;
                    setReference(e.target.value);
                  }}
                />
              </label>
            )}
            {/* SA-1026: a walk-in has no account to collect on, so the choice is not offered at all */}
            {method === "CHECK" && !isWalkIn && (
              <CheckNotReceivedChoice
                checked={checkNotReceived}
                onChange={(v) => {
                  setCheckNotReceived(v);
                  setError(null);
                }}
              />
            )}
          </section>
        )}
        {error && (
          <p
            role="alert"
            className={cn(
              "rounded px-3 py-2 text-xs",
              onRunWarning
                ? "border border-amber-300 bg-amber-50 text-navy"
                : "bg-danger-bg text-danger",
            )}
          >
            {error}
          </p>
        )}
        {(errorCode === API_ERROR_CODES.COUNTER_COMPLETE_STOP_STARTED ||
          errorCode === API_ERROR_CODES.ORDER_ON_ACTIVE_RUN) &&
          errorRunId && (
            <Link
              href={`/routes/${errorRunId}`}
              className="text-sm font-semibold text-brand-600 underline"
            >
              Open the route
            </Link>
          )}
      </div>
      {rw.dialog}
    </Modal>
  );
}
