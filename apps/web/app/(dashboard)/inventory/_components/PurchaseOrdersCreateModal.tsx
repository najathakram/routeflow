"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { useCreatePurchaseOrder } from "@/lib/api/inventory";
import {
  emptyPOLine,
  resolvePOLine,
  type POLineItem,
  type Supplier,
} from "./purchase-orders-shared";

export function CreatePOModal({
  suppliers,
  products,
  onClose,
  defaultSupplierId,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string; unitsPerBox?: number | null }[];
  onClose: () => void;
  defaultSupplierId?: string;
}) {
  const createPO = useCreatePurchaseOrder();
  const { toast } = useToast();
  const [supplierId, setSupplierId] = React.useState(defaultSupplierId ?? "");
  const [expectedDate, setExpectedDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<POLineItem[]>([emptyPOLine()]);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const unitsPerBoxFor = (productId: string) =>
    Number(productById.get(productId)?.unitsPerBox ?? 0);

  const addLine = () => setLines((l) => [...l, emptyPOLine()]);
  const removeLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));
  const updateLine = (i: number, field: keyof POLineItem, val: string) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, [field]: val } : line)));

  const total = lines.reduce((sum, l) => {
    const { qty, unitCost } = resolvePOLine(l, unitsPerBoxFor(l.productId));
    return sum + qty * unitCost;
  }, 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = lines
      .filter((l) => {
        if (!l.productId || !l.unitCost) return false;
        const upb = unitsPerBoxFor(l.productId);
        return upb > 1 ? Number(l.boxes) > 0 || Number(l.pieces) > 0 : !!l.qty;
      })
      .map((l) => {
        const { qty, unitCost } = resolvePOLine(l, unitsPerBoxFor(l.productId));
        return { productId: l.productId, qty, unitCost };
      });

    if (items.length === 0) {
      toast({
        title: "Validation",
        description: "Add at least one line item.",
        variant: "warning",
      });
      return;
    }

    createPO.mutate(
      {
        supplierId: supplierId || undefined,
        expectedDate: expectedDate || undefined,
        items,
        notes: notes || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Purchase order created.", variant: "success" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create purchase order.", variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Create Purchase Order</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          onSubmit={handleSubmit}
          className="space-y-5 overflow-y-auto px-6 py-5"
          style={{ maxHeight: "80vh" }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-navy">Supplier</label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">No supplier</option>
                {suppliers
                  .filter((s) => s.isActive)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-navy">Expected Date</label>
              <input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-semibold text-navy">Line Items</label>
              <button
                type="button"
                onClick={addLine}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
              >
                <Plus className="h-3 w-3" /> Add Row
              </button>
            </div>

            <div className="rounded-lg border border-surface-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-xs text-navy/70">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-left font-medium w-24">Qty</th>
                    <th className="px-3 py-2 text-left font-medium w-28">Unit Cost ($)</th>
                    <th className="px-3 py-2 text-right font-medium w-24">Subtotal</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {lines.map((line, i) => {
                    const upb = unitsPerBoxFor(line.productId);
                    const isBoxed = upb > 1;
                    const { qty, unitCost } = resolvePOLine(line, upb);
                    const subtotal = qty * unitCost;
                    return (
                      <tr key={i}>
                        <td className="px-3 py-2">
                          <select
                            value={line.productId}
                            onChange={(e) => updateLine(i, "productId", e.target.value)}
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="">Select…</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {p.sku ? ` (${p.sku})` : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          {isBoxed ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                step={1}
                                placeholder="0"
                                title="Boxes"
                                value={line.boxes}
                                onChange={(e) => updateLine(i, "boxes", e.target.value)}
                                className="w-full min-w-0 rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                              <span className="text-navy/30">+</span>
                              <input
                                type="number"
                                min={0}
                                max={upb - 1}
                                step={1}
                                placeholder="0"
                                title="Extra pieces"
                                value={line.pieces}
                                onChange={(e) => updateLine(i, "pieces", e.target.value)}
                                className="w-full min-w-0 rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                            </div>
                          ) : (
                            <input
                              type="number"
                              min={0.001}
                              step={0.001}
                              placeholder="0"
                              value={line.qty}
                              onChange={(e) => updateLine(i, "qty", e.target.value)}
                              className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          )}
                          {isBoxed && (
                            <p className="mt-0.5 text-[10px] text-navy/50">
                              boxes + pcs · {qty} pcs total
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            step={0.0001}
                            placeholder="0.00"
                            title={isBoxed ? "Cost per box" : "Cost per unit"}
                            value={line.unitCost}
                            onChange={(e) => updateLine(i, "unitCost", e.target.value)}
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <p className="mt-0.5 text-[10px] text-navy/50">
                            {isBoxed ? "per box" : "per unit"}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-right text-navy/70">
                          {subtotal > 0 ? formatMoney(subtotal) : "—"}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            disabled={lines.length === 1}
                            className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t border-surface-border bg-surface-raised/50">
                  <tr>
                    <td
                      colSpan={3}
                      className="px-3 py-2 text-right text-xs font-medium text-navy/70"
                    >
                      Total
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold text-navy">
                      {formatMoney(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" loading={createPO.isPending}>
              Create PO
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
