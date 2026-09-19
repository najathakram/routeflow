"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { unitsLabel } from "@/lib/stock-label";
import { useReceivePurchaseOrder } from "@/lib/api/inventory";
import type { POItem, PurchaseOrder } from "./purchase-orders-shared";

export function ReceivePOModal({
  po,
  products,
  onClose,
}: {
  po: PurchaseOrder;
  /** Same catalog list threaded through from the page — carries `unitsPerBox`
   *  (the PO item payload never does) and a name for the LIST endpoint's items,
   *  which come back without the `product` relation. */
  products: { id: string; name?: string; unitsPerBox?: number | null }[];
  onClose: () => void;
}) {
  const receivePO = useReceivePurchaseOrder();
  const { toast } = useToast();

  const catalogById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const unitsPerBoxFor = (productId: string) =>
    Number(catalogById.get(productId)?.unitsPerBox ?? 0);
  /** Still outstanding on this line — never pre-fill more, the API rejects a
   *  receipt larger than what remains rather than silently under-receiving.
   *  Rounded to the column's 3dp: quantities are Decimal(10,3) and the raw
   *  float subtraction yields artifacts (1.2 − 0.4 = 0.7999999999999999) that
   *  would both pre-fill and label a 16-digit quantity. */
  const outstandingOf = (item: POItem) =>
    Math.max(
      0,
      Math.round((Number(item.qtyOrdered ?? 0) - Number(item.qtyReceived ?? 0)) * 1000) / 1000,
    );

  // Non-boxed items: a single pieces input (unchanged behavior).
  const [receivedQtys, setReceivedQtys] = React.useState<Record<string, string>>(
    Object.fromEntries(po.items.map((item) => [item.id, String(outstandingOf(item))])),
  );
  // Boxed items: Boxes + Pieces, defaulting to the outstanding qty's own
  // breakdown (qtyOrdered is a piece total — see resolvePOLine in purchase-orders-shared.ts).
  const [receivedSplits, setReceivedSplits] = React.useState<
    Record<string, { boxes: string; pieces: string }>
  >(
    Object.fromEntries(
      po.items.map((item) => {
        const upb = unitsPerBoxFor(item.productId);
        const split = normalizeBoxesPieces({ qty: outstandingOf(item), unitsPerBox: upb });
        return [item.id, { boxes: String(split.boxes ?? 0), pieces: String(split.pieces ?? 0) }];
      }),
    ),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = po.items.map((item) => {
      const upb = unitsPerBoxFor(item.productId);
      if (upb > 1) {
        const split = receivedSplits[item.id] ?? { boxes: "0", pieces: "0" };
        const boxes = Math.max(0, Math.trunc(Number(split.boxes) || 0));
        const pieces = Math.max(0, Math.trunc(Number(split.pieces) || 0));
        // Sent as a piece total via `receivedQty` (the API accepts an
        // equivalent `boxes`/`pieces` split too). Quantity is the only thing
        // that converts: this line's `unitCost` is already per piece from
        // creation (CreatePOModal's resolvePOLine) and receiving never
        // re-scales it.
        return {
          id: item.id,
          receivedQty: normalizeBoxesPieces({ boxes, pieces, unitsPerBox: upb }).qty,
        };
      }
      return { id: item.id, receivedQty: Number(receivedQtys[item.id] ?? 0) };
    });
    receivePO.mutate(
      { id: po.id, items },
      {
        onSuccess: () => {
          toast({ title: "Purchase order received.", variant: "success" });
          onClose();
        },
        onError: () => toast({ title: "Failed to receive purchase order.", variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Receive — {po.poNumber}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <p className="text-xs text-navy/70">
            Enter the quantity actually received for each item.
          </p>
          <div className="rounded-lg border border-surface-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-center font-medium w-24">Ordered</th>
                  <th className="px-3 py-2 text-center font-medium w-28">Received Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {po.items.map((item) => {
                  const upb = unitsPerBoxFor(item.productId);
                  const isBoxed = upb > 1;
                  const split = receivedSplits[item.id] ?? { boxes: "0", pieces: "0" };
                  const ordered = Number(item.qtyOrdered ?? 0);
                  const outstanding = outstandingOf(item);
                  return (
                    <tr key={item.id}>
                      <td className="px-3 py-2 font-medium text-navy">
                        {item.product?.name ?? catalogById.get(item.productId)?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-center text-navy">
                        {isBoxed ? unitsLabel(ordered, upb) : ordered}
                        {outstanding !== ordered && (
                          <span className="block text-[11px] text-navy/50">
                            {isBoxed ? unitsLabel(outstanding, upb) : outstanding} left
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isBoxed ? (
                          <div className="flex items-center justify-center gap-1">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              title="Boxes"
                              value={split.boxes}
                              onChange={(e) =>
                                setReceivedSplits((prev) => ({
                                  ...prev,
                                  [item.id]: { ...split, boxes: e.target.value },
                                }))
                              }
                              className="w-14 rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <span className="text-navy/30">+</span>
                            <input
                              type="number"
                              min={0}
                              max={upb - 1}
                              step={1}
                              title="Extra pieces"
                              value={split.pieces}
                              onChange={(e) =>
                                setReceivedSplits((prev) => ({
                                  ...prev,
                                  [item.id]: { ...split, pieces: e.target.value },
                                }))
                              }
                              className="w-14 rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </div>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            step={0.001}
                            value={receivedQtys[item.id] ?? ""}
                            onChange={(e) =>
                              setReceivedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" loading={receivePO.isPending}>
              Confirm Receipt
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
