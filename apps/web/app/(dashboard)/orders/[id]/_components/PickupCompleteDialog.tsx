"use client";

import * as React from "react";
import { Button, Modal, cn } from "@routeflow/ui/web";
import type { CounterSalePaymentMethod, PickupCompleteResponse } from "@routeflow/types";
import { usePickupComplete, usePickupInvoiceBalances } from "@/lib/api/counter-sale";
import {
  PAYMENT_PROBLEM_COPY,
  PICKUP_DEAD_INVOICE,
  changeDue,
  newIdempotencyKey,
  paymentMethodOptions,
  pickupBalanceDue,
  pickupCompleteErrorCopy,
  quickTenderOptions,
  validatePayment,
} from "@/lib/counter-sale";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

type Body = { payment?: { method: CounterSalePaymentMethod; amount?: number; reference?: string } };

/**
 * "Picked up" on a PICKUP order (order ahead): payment is taken AT pickup. Opening the dialog mints ONE
 * Idempotency-Key that every attempt in it reuses (a retry of a failed or not-recorded payment must be the
 * same hand-over, never a second); closing and reopening mints a new one. The tender is the till's: same
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
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber?: string;
  total: number;
  invoices: ReadonlyArray<{ id: string; status: string }>;
  isWalkIn: boolean;
}) {
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
  const nothingToCollect = balanceDue !== null && balanceDue <= 0;

  const keyRef = React.useRef<string>("");
  const [method, setMethod] = React.useState<CounterSalePaymentMethod>("CASH");
  const [tendered, setTendered] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<PickupCompleteResponse | null>(null);
  const lastBody = React.useRef<Body>({});

  React.useEffect(() => {
    if (open) {
      keyRef.current = newIdempotencyKey();
      setMethod("CASH");
      setTendered("");
      setReference("");
      setError(null);
      setOutcome(null);
    }
  }, [open]);

  const tenderedNum = Number(tendered) || 0;

  async function send(body: Body) {
    setError(null);
    lastBody.current = body;
    try {
      setOutcome(await complete.mutateAsync({ body, idempotencyKey: keyRef.current }));
    } catch (err) {
      setError(pickupCompleteErrorCopy(err));
    }
  }

  function confirm() {
    if (balanceDue === null) return;
    if (nothingToCollect) return void send({});
    const problem = validatePayment({
      method,
      total: balanceDue,
      tendered: tenderedNum,
      reference,
      isWalkIn,
    });
    if (problem) return setError(PAYMENT_PROBLEM_COPY[problem]);
    void send({
      payment: {
        method,
        ...(method === "CASH" ? { amount: tenderedNum } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      },
    });
  }

  const unrecorded = outcome !== null && !outcome.paymentRecorded;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Picked up${orderNumber ? ` — ${orderNumber}` : ""}`}
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
            <Button
              type="button"
              onClick={confirm}
              loading={complete.isPending}
              disabled={balanceDue === null}
            >
              {nothingToCollect ? "Confirm picked up" : "Picked up"}
            </Button>
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
                Picked up —{" "}
                {outcome.balanceDue > 0 ? `${money(outcome.balanceDue)} still due` : "paid"}
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
        ) : balanceDue === null ? (
          <p className="text-sm text-navy/70">Checking the balance…</p>
        ) : nothingToCollect ? (
          <p className="text-sm font-medium text-navy">Paid — nothing to collect</p>
        ) : (
          <section aria-label="Payment" className="space-y-3">
            <p className="text-sm text-navy">
              Collect <strong>{money(balanceDue)}</strong>
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
                  {quickTenderOptions(balanceDue).map((q) => (
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
                  Change {money(changeDue(balanceDue, tenderedNum))}
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
