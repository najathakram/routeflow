"use client";

import * as React from "react";
import { Loader2, Printer, Truck } from "lucide-react";
import { Button, Modal, cn, useToast } from "@routeflow/ui/web";
import { BATCH_SHIP_MAX_ORDERS, type BatchShipResultRow } from "@routeflow/types";
import { useBatchShipOrders, usePackingSlips } from "@/lib/api/orders";
import { useTenantFeatures } from "@/lib/tenant-features";
import { CARRIERS } from "@/lib/shipping";
import { printPdfBlob } from "@/lib/print-pdf-blob";
import { BATCH_SHIP_COPY, batchShipDetail, shippedOrderIds } from "@/lib/batch-ship-copy";

/**
 * Bulk-bar actions for carrier orders (#3168): "Mark shipped (n)" opens a dialog with an optional
 * carrier/tracking per order, then a per-order result list with a "Print packing slips" button for the
 * orders that shipped; "Print packing slips" prints slips for the selection as it stands. Shown only
 * when the tenant's fulfilment methods include SHIP (hide-only: the server refuses non-carrier orders
 * regardless). Ungated by plan: it is offered wherever SHIP is.
 */
type Row = { id: string; orderNumber: string; customerName?: string };

export function BatchShipActions({
  orders,
  onDone,
}: {
  /** The selected orders, in display order. */
  orders: Row[];
  /** Called when the dialog closes after a batch ran (the page clears the selection). */
  onDone: () => void;
}) {
  const { data } = useTenantFeatures();
  const offersShip = data?.capabilities?.fulfilment?.methods?.includes("SHIP") ?? false;
  const { toast } = useToast();
  const batchShip = useBatchShipOrders();
  const slips = usePackingSlips();
  const [open, setOpen] = React.useState(false);
  const [carriers, setCarriers] = React.useState<Record<string, string>>({});
  const [tracking, setTracking] = React.useState<Record<string, string>>({});
  const [results, setResults] = React.useState<BatchShipResultRow[] | null>(null);

  if (!offersShip || orders.length === 0) return null;

  // The API 400s above BATCH_SHIP_MAX_ORDERS, so block it here.
  const tooMany = orders.length > BATCH_SHIP_MAX_ORDERS;

  const printSlips = async (ids: string[]) => {
    if (ids.length > BATCH_SHIP_MAX_ORDERS) return;
    try {
      const res = await slips.mutateAsync(ids);
      if (!res.blob) {
        toast({
          title: "No packing slips to print",
          description: "Only carrier orders have packing slips.",
          variant: "error",
        });
        return;
      }
      printPdfBlob(res.blob);
      if (res.skipped.length > 0) {
        toast({
          title: `${res.skipped.length} order${res.skipped.length !== 1 ? "s" : ""} skipped`,
          description: "Packing slips are for carrier orders that are not cancelled.",
          variant: "error",
        });
      }
    } catch {
      toast({
        title: "Failed to generate packing slips",
        description: "Please try again.",
        variant: "error",
      });
    }
  };

  const close = () => {
    const ran = results !== null;
    setOpen(false);
    setResults(null);
    setCarriers({});
    setTracking({});
    if (ran) onDone();
  };

  const submit = async () => {
    try {
      const res = await batchShip.mutateAsync({
        orders: orders.map((o) => {
          const t = (tracking[o.id] ?? "").trim();
          return t
            ? { orderId: o.id, carrier: carriers[o.id] ?? CARRIERS[0].id, trackingNumber: t }
            : { orderId: o.id };
        }),
      });
      setResults(res.results);
    } catch {
      toast({
        title: "Failed to mark orders shipped",
        description: "Please try again.",
        variant: "error",
      });
    }
  };

  const numberOf = (id: string) => orders.find((o) => o.id === id)?.orderNumber ?? "";
  const shipped = results ? shippedOrderIds(results) : [];

  return (
    <>
      <span className="h-[18px] w-px bg-white/20" />
      <button
        type="button"
        data-testid="batch-ship-open"
        onClick={() => setOpen(true)}
        disabled={tooMany}
        className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors disabled:opacity-60"
      >
        <Truck className="h-3.5 w-3.5" />
        Mark shipped ({orders.length})
      </button>
      <button
        type="button"
        data-testid="batch-ship-slips-open"
        onClick={() => void printSlips(orders.map((o) => o.id))}
        disabled={slips.isPending || tooMany}
        className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors disabled:opacity-60"
      >
        {slips.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Printer className="h-3.5 w-3.5" />
        )}
        Print packing slips
      </button>
      {tooMany && (
        <span data-testid="batch-ship-limit" role="status" className="text-[12.5px] text-amber-300">
          Select up to {BATCH_SHIP_MAX_ORDERS} orders to ship at once
        </span>
      )}

      <Modal
        open={open}
        onClose={close}
        scroll
        title={results ? "Shipping results" : `Mark ${orders.length} shipped`}
        description={
          results
            ? undefined
            : "Carrier and tracking are optional. Customers get one shipped email per order."
        }
        className="max-w-2xl"
        footer={
          results ? (
            <>
              <Button
                type="button"
                variant="secondary"
                data-testid="batch-ship-done"
                onClick={close}
              >
                Done
              </Button>
              {shipped.length > 0 && (
                <Button
                  type="button"
                  data-testid="batch-ship-print-slips"
                  loading={slips.isPending}
                  onClick={() => void printSlips(shipped)}
                >
                  Print packing slips ({shipped.length})
                </Button>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" data-testid="batch-ship-cancel" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="batch-ship-submit"
                loading={batchShip.isPending}
                onClick={() => void submit()}
              >
                Mark shipped
              </Button>
            </>
          )
        }
      >
        <div data-testid="batch-ship-dialog" className="space-y-2">
          {results
            ? results.map((r) => {
                const copy = BATCH_SHIP_COPY[r.outcome];
                return (
                  <div
                    key={r.orderId}
                    data-testid={`batch-ship-result-${r.orderId}`}
                    data-outcome={r.outcome}
                    className="flex items-start justify-between gap-3 rounded border border-surface-border p-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-navy">
                        {r.orderNumber ?? numberOf(r.orderId)}
                      </div>
                      <div className="text-xs text-navy/60">{batchShipDetail(r)}</div>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded px-2 py-0.5 text-xs font-semibold",
                        copy.tone === "ok" && "bg-green-50 text-green-700",
                        copy.tone === "warn" && "bg-amber-50 text-amber-700",
                        copy.tone === "error" && "bg-red-50 text-red-700",
                      )}
                    >
                      {copy.label}
                    </span>
                  </div>
                );
              })
            : orders.map((o) => (
                <div
                  key={o.id}
                  data-testid={`batch-ship-row-${o.id}`}
                  className="grid grid-cols-1 gap-2 rounded border border-surface-border p-2.5 sm:grid-cols-[1fr_8rem_12rem] sm:items-center"
                >
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-navy">{o.orderNumber}</div>
                    {o.customerName && (
                      <div className="truncate text-xs text-navy/60">{o.customerName}</div>
                    )}
                  </div>
                  <select
                    data-testid={`batch-ship-carrier-${o.id}`}
                    aria-label={`Carrier for ${o.orderNumber}`}
                    value={carriers[o.id] ?? CARRIERS[0].id}
                    onChange={(e) => setCarriers((p) => ({ ...p, [o.id]: e.target.value }))}
                    className="h-10 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy"
                  >
                    {CARRIERS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    data-testid={`batch-ship-tracking-${o.id}`}
                    aria-label={`Tracking number for ${o.orderNumber}`}
                    type="text"
                    maxLength={128}
                    value={tracking[o.id] ?? ""}
                    onChange={(e) => setTracking((p) => ({ ...p, [o.id]: e.target.value }))}
                    placeholder="Tracking number"
                    className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40"
                  />
                </div>
              ))}
        </div>
      </Modal>
    </>
  );
}
