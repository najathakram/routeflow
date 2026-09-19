"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import { useUpdatePurchaseOrder, type UpdatePurchaseOrderInput } from "@/lib/api/inventory";
import { resolvePOLine, type PurchaseOrder, type Supplier } from "./purchase-orders-shared";
import {
  buildUpdateItems,
  emptyEditLine,
  explainEditError,
  isReceived,
  linesChanged,
  toEditLine,
  validateEditLines,
  type EditLine,
} from "./purchase-orders-edit";

type CatalogProduct = { id: string; name: string; sku?: string; unitsPerBox?: number | null };

const inputCls =
  "w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

/**
 * Edit a purchase order (LANE-U step 6, web half). DRAFT/SENT orders edit freely. A
 * PARTIAL/RECEIVED order's lines are protected: a received line can't drop below what
 * arrived, change product or be removed (a return is the only way out), extra quantity
 * or a new line is outstanding and arrives later through the normal receive — and
 * saving a change to the lines asks "Re-apply to inventory?" because the API needs an
 * explicit answer: [Re-apply] restates the cost of what was received in stock and
 * average cost, [Keep stock as is] changes the document only.
 */
export function PurchaseOrdersEditModal({
  po,
  suppliers,
  products,
  onClose,
}: {
  po: PurchaseOrder;
  suppliers: Supplier[];
  products: CatalogProduct[];
  onClose: () => void;
}) {
  const updatePO = useUpdatePurchaseOrder();
  const { toast } = useToast();
  const received = isReceived(po);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const unitsPerBoxFor = React.useCallback(
    (productId: string) => Number(productById.get(productId)?.unitsPerBox ?? 0),
    [productById],
  );

  const originalDate = po.expectedDate ? po.expectedDate.slice(0, 10) : "";
  const [supplierId, setSupplierId] = React.useState(po.supplier?.id ?? "");
  const [expectedDate, setExpectedDate] = React.useState(originalDate);
  const [notes, setNotes] = React.useState(po.notes ?? "");
  const [lines, setLines] = React.useState<EditLine[]>(() =>
    po.items.map((i) => toEditLine(i, unitsPerBoxFor(i.productId))),
  );
  const [error, setError] = React.useState<string | null>(null);
  /** The pending payload while the operator answers "Re-apply to inventory?". */
  const [pending, setPending] = React.useState<UpdatePurchaseOrderInput | null>(null);

  const supplierChanged = supplierId !== (po.supplier?.id ?? "");

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  const removeLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));

  const total = lines.reduce((sum, l) => {
    const { qty, unitCost } = resolvePOLine(l, unitsPerBoxFor(l.productId));
    return sum + qty * unitCost;
  }, 0);

  /** A line's product may be missing from the catalog list (archived) — keep it selectable. */
  const nameFor = (line: EditLine) =>
    productById.get(line.productId)?.name ??
    po.items.find((i) => i.id === line.id)?.product?.name ??
    "—";

  const send = (payload: UpdatePurchaseOrderInput) => {
    setError(null);
    updatePO.mutate(
      { id: po.id, ...payload },
      {
        onSuccess: () => {
          toast({ title: "Purchase order updated.", variant: "success" });
          onClose();
        },
        onError: (err) => {
          const message = explainEditError(err) ?? "Failed to update purchase order.";
          setError(message);
          toast({
            title: "Couldn't update the purchase order.",
            description: message,
            variant: "error",
          });
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateEditLines(lines, unitsPerBoxFor);
    if (problem) {
      setError(problem);
      return;
    }
    const items = buildUpdateItems(lines, unitsPerBoxFor);
    const changed = linesChanged(po, items);

    const payload: UpdatePurchaseOrderInput = {
      ...(supplierChanged ? { supplierId } : {}),
      ...(expectedDate !== originalDate ? { expectedDate: expectedDate || null } : {}),
      ...(notes !== (po.notes ?? "") ? { notes: notes || null } : {}),
      ...(changed ? { items } : {}),
    };
    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    if (received && (changed || supplierChanged)) {
      setPending(payload); // ask what should happen to stock
      return;
    }
    send(payload);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Edit {po.poNumber}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {pending ? (
          <div className="space-y-4 px-6 py-5" role="dialog" aria-label="Re-apply to inventory?">
            <h3 className="text-sm font-semibold text-navy">Re-apply to inventory?</h3>
            <p className="text-sm text-navy/80">
              {po.poNumber} has already been received. <strong>Re-apply</strong> restates the cost
              (and supplier) of what was received in your stock and average cost.{" "}
              <strong>Keep stock as is</strong> changes the purchase order only — stock and cost
              stay exactly as they are.
            </p>
            <p className="text-xs text-navy/60">
              Either way, the quantity that was received doesn&apos;t change. Extra quantity or a
              new line stays outstanding until you receive it.
            </p>
            {supplierChanged && (
              <p className="text-xs text-amber-700">
                A supplier change can only be saved together with re-applying inventory.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
              >
                Back
              </Button>
              <Button
                variant="secondary"
                type="button"
                disabled={supplierChanged || updatePO.isPending}
                onClick={() => send({ ...pending, reapplyInventory: false })}
              >
                Keep stock as is
              </Button>
              <Button
                type="button"
                loading={updatePO.isPending}
                onClick={() => send({ ...pending, reapplyInventory: true })}
              >
                Re-apply
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            // The browser's own min/step checks would swallow our messages (e.g. why a received
            // quantity can't drop) — validateEditLines explains it instead.
            noValidate
            className="space-y-5 overflow-y-auto px-6 py-5"
            style={{ maxHeight: "80vh" }}
          >
            {received && (
              <p className="rounded bg-surface-raised px-3 py-2 text-xs text-navy/80">
                Already received: a received line can&apos;t go below what arrived, change product
                or be removed. Extra quantity and new lines stay outstanding.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="po-edit-supplier" className="mb-1 block text-xs text-navy">
                  Supplier
                </label>
                <select
                  id="po-edit-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className={inputCls}
                >
                  {!suppliers.some((s) => s.id === supplierId) && (
                    <option value={supplierId}>{po.supplier?.name ?? "—"}</option>
                  )}
                  {suppliers
                    .filter((s) => s.isActive || s.id === supplierId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label htmlFor="po-edit-date" className="mb-1 block text-xs text-navy">
                  Expected Date
                </label>
                <input
                  id="po-edit-date"
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-navy">Line Items</span>
                <button
                  type="button"
                  onClick={() => setLines((l) => [...l, emptyEditLine()])}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
                >
                  <Plus className="h-3 w-3" /> Add Row
                </button>
              </div>
              <div className="overflow-hidden rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-raised text-xs text-navy/70">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Product</th>
                      <th className="w-28 px-3 py-2 text-left font-medium">Qty</th>
                      <th className="w-28 px-3 py-2 text-left font-medium">Unit Cost ($)</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Subtotal</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {lines.map((line, i) => {
                      const upb = unitsPerBoxFor(line.productId);
                      const isBoxed = upb > 1;
                      const locked = received && !!line.id && line.received > 0;
                      const { qty, unitCost } = resolvePOLine(line, upb);
                      const subtotal = qty * unitCost;
                      return (
                        <tr key={line.id ?? `new-${i}`}>
                          <td className="px-3 py-2">
                            <select
                              aria-label="Product"
                              value={line.productId}
                              disabled={locked}
                              onChange={(e) => updateLine(i, { productId: e.target.value })}
                              className={inputCls}
                            >
                              <option value="">Select…</option>
                              {!productById.has(line.productId) && line.productId && (
                                <option value={line.productId}>{nameFor(line)}</option>
                              )}
                              {products.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                  {p.sku ? ` (${p.sku})` : ""}
                                </option>
                              ))}
                            </select>
                            {locked && (
                              <p className="mt-0.5 text-[10px] text-navy/50">
                                Received: {isBoxed ? unitsLabel(line.received, upb) : line.received}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isBoxed ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  title="Boxes"
                                  value={line.boxes}
                                  onChange={(e) => updateLine(i, { boxes: e.target.value })}
                                  className={inputCls}
                                />
                                <span className="text-navy/30">+</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={upb - 1}
                                  step={1}
                                  title="Extra pieces"
                                  value={line.pieces}
                                  onChange={(e) => updateLine(i, { pieces: e.target.value })}
                                  className={inputCls}
                                />
                              </div>
                            ) : (
                              <input
                                type="number"
                                min={locked ? line.received : 0.001}
                                step={0.001}
                                aria-label="Quantity"
                                value={line.qty}
                                onChange={(e) => updateLine(i, { qty: e.target.value })}
                                className={inputCls}
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
                              title={isBoxed ? "Cost per box" : "Cost per unit"}
                              aria-label="Unit cost"
                              value={line.unitCost}
                              onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                              className={inputCls}
                            />
                            <p className="mt-0.5 text-[10px] text-navy/50">
                              {isBoxed ? "per box" : "per unit"}
                            </p>
                          </td>
                          <td className="px-3 py-2 text-right text-navy/70">
                            {subtotal > 0 ? formatMoney(subtotal) : "—"}
                          </td>
                          <td className="px-2 py-2">
                            {!locked && (
                              <button
                                type="button"
                                aria-label="Remove line"
                                onClick={() => removeLine(i)}
                                disabled={lines.length === 1}
                                className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
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
              <label htmlFor="po-edit-notes" className="mb-1 block text-xs text-navy">
                Notes
              </label>
              <textarea
                id="po-edit-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {error && (
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose} type="button">
                Cancel
              </Button>
              <Button type="submit" loading={updatePO.isPending}>
                Save changes
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
