"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import type { CounterSalePaymentMethod, PickupCompleteResponse } from "@routeflow/types";
import { usePickupComplete, usePickupInvoiceBalances } from "@/lib/api/counter-sale";
import {
  paymentProblemCopy,
  PICKUP_DEAD_INVOICE,
  changeDue,
  clearHeldPickupKey,
  newIdempotencyKey,
  paymentMethodOptions,
  pickupBalanceDue,
  pickupCompleteErrorCopy,
  pickupErrorCode,
  quickTenderOptions,
  readHeldPickupKey,
  validatePayment,
  writeHeldPickupKey,
} from "@/lib/counter-sale";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** The key of an attempt whose outcome is UNKNOWN, held by the parent across close/reopen, per order. */
export type HeldPickupKey = { orderId: string; key: string } | null;

type Body = { payment?: { method: CounterSalePaymentMethod; amount?: number; reference?: string } };

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
  handOver = false,
  heldKey,
  storeKey = null,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber?: string;
  total: number;
  invoices: ReadonlyArray<{ id: string; status: string }>;
  isWalkIn: boolean;
  /** POS-mode order (PICKUP, not a counter sale): the confirm button reads "Hand over". Counter / portal keep "Picked up". */
  handOver?: boolean;
  heldKey?: React.MutableRefObject<HeldPickupKey>;
  /** sessionStorage key (tenant + user + order) that keeps an UNKNOWN outcome's key across a reload. */
  storeKey?: string | null;
}) {
  const ownHeld = React.useRef<HeldPickupKey>(null);
  const held = heldKey ?? ownHeld;
  const complete = usePickupComplete(orderId);
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
  const [tendered, setTendered] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | undefined>();
  const [outcome, setOutcome] = React.useState<PickupCompleteResponse | null>(null);
  const lastBody = React.useRef<Body>({});

  React.useEffect(() => {
    if (open) {
      if (held.current?.orderId !== orderId) {
        const stored = readHeldPickupKey(storeKey);
        held.current = stored ? { orderId, key: stored } : null;
      }
      keyRef.current = held.current?.orderId === orderId ? held.current.key : newIdempotencyKey();
      setMethod("CASH");
      setTendered("");
      setReference("");
      setError(null);
      setErrorCode(undefined);
      setOwed(null);
      setOutcome(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tenderedNum = Number(tendered) || 0;

  async function send(body: Body) {
    setError(null);
    setErrorCode(undefined);
    lastBody.current = body;
    try {
      const res = await complete.mutateAsync({ body, idempotencyKey: keyRef.current });
      const code = res.paymentRecorded ? undefined : res.paymentErrorCode;
      if (
        code === API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED ||
        code === API_ERROR_CODES.COUNTER_TENDER_SHORT
      ) {
        // Back to the tender step; the next attempt is the same hand-over (same key) carrying the payment.
        if (res.balanceDue > 0) setOwed(res.balanceDue);
        setErrorCode(code);
        setError(pickupCompleteErrorCopy({ response: { data: { code } } }));
        return;
      }
      held.current = null;
      clearHeldPickupKey(storeKey);
      setOutcome(res);
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      const unknown = status === undefined || status >= 500;
      held.current = unknown ? { orderId, key: keyRef.current } : null;
      if (unknown) writeHeldPickupKey(storeKey, keyRef.current);
      else clearHeldPickupKey(storeKey);
      setErrorCode(pickupErrorCode(err));
      setError(pickupCompleteErrorCopy(err, due ?? undefined));
    }
  }

  function reload() {
    void qc.invalidateQueries({ queryKey: ["orders"] });
    onClose();
  }

  function confirm() {
    if (due === null) return;
    if (nothingToCollect) return void send({});
    const problem = validatePayment({
      method,
      total: due,
      tendered: tenderedNum,
      reference,
      isWalkIn,
    });
    if (problem) return setError(paymentProblemCopy(problem, due));
    void send({
      payment: {
        method,
        ...(method === "CASH" ? { amount: roundMoney(tenderedNum) } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      },
    });
  }

  const unrecorded = outcome !== null && !outcome.paymentRecorded;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${handOver ? "Hand over" : "Picked up"}${orderNumber ? ` ${orderNumber}` : ""}`}
      className="max-w-md"
      footer={
        outcome ? (
          <>
            {unrecorded && (
              <Button
                variant="secondary"
                type="button"
                loading={complete.isPending}
                onClick={() => void send(lastBody.current)}
              >
                Retry
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" type="button" disabled={complete.isPending} onClick={onClose}>
              Cancel
            </Button>
            {/* Both mean the order is already handed over: nothing to retry, only to reload what the page shows. */}
            {errorCode === API_ERROR_CODES.PICKUP_KEY_CONFLICT ||
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
                <Button
                  type="button"
                  onClick={confirm}
                  loading={complete.isPending}
                  disabled={due === null}
                >
                  {handOver ? "Hand over" : nothingToCollect ? "Confirm picked up" : "Picked up"}
                </Button>
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
                {outcome.balanceDue > 0
                  ? `Picked up. ${money(outcome.balanceDue)} still due.`
                  : "Picked up and paid."}
              </p>
            )}
            {unrecorded && (
              <p className="text-xs text-navy/70">
                The order is handed over, but the payment was not saved. Retry to record it.
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
              {paymentMethodOptions(isWalkIn)
                .filter((m) => !m.disabled) // a walk-in has no account: On account is not offered at all
                .map((m) => (
                  <button
                    key={m.method}
                    type="button"
                    disabled={m.disabled}
                    aria-pressed={method === m.method}
                    className={cn(
                      "rounded border px-3 py-2 text-sm disabled:opacity-40",
                      method === m.method && "border-brand-600 bg-brand-50 font-semibold",
                    )}
                    onClick={() => {
                      setMethod(m.method);
                      setError(null);
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
                      disabled={q.disabled}
                      className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                      onClick={() => setTendered(String(q.amount))}
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
                    onChange={(e) => setTendered(e.target.value)}
                  />
                </label>
                <p className="text-2xl font-bold" data-testid="pickup-change-due">
                  Change {money(changeDue(due, tenderedNum))}
                </p>
              </div>
            )}
            {method === "CHECK" && (
              <label className="block text-sm">
                Check number
                <input
                  aria-label="Check number"
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="rounded bg-danger-bg px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
