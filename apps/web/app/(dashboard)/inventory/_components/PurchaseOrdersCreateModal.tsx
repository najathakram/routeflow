"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { MODAL_BODY, MODAL_FOOTER, MODAL_FORM, MODAL_PANEL } from "./modal-panel";
import { formatMoney } from "@/lib/format";
import { useCreatePurchaseOrder } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { PurchaseOrderScanBar } from "./PurchaseOrderScanBar";
import { addEntryUnit, catalogMetaById, poSelectOptions } from "./po-scan-lines";
import {
  emptyPOLine,
  resolvePOLine,
  resolvePOLineAmounts,
  toCreateItem,
  type POLineItem,
  type Supplier,
} from "./purchase-orders-shared";
import { unitWords, type SellLevel } from "@routeflow/pricing";

// U-3a: a PO line carries no per-product label yet, so this prints the default words.
const UW = unitWords();

/** A line field's form name ("boxes-0"): names the control for autofill and tests. */
const fieldName = (key: string, i: number) => `${key}-${i}`;

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

  // A product picked by the bar that the page's list lacks still needs its pack and a select option.
  const [picked, setPicked] = React.useState<typeof products>([]);
  const allProducts = React.useMemo(
    () => [...products, ...picked.filter((p) => !products.some((q) => q.id === p.id))],
    [products, picked],
  );
  // Parent and kind per product (the stock list carries neither): one catalog read, for the full-name sort.
  // The Stock tab's exact params, so the two share one cached read. Until it arrives the modal fails
  // closed: no options (a bare variant name or a family must never be offered) and the bar is off.
  const {
    data: catalog,
    isError: catalogError,
    isFetching: catalogFetching,
    refetch: refetchCatalog,
  } = useProducts({ includeVariants: true, limit: 0 });
  const catalogReady = catalog !== undefined;
  const options = React.useMemo(
    () => (catalogReady ? poSelectOptions(allProducts, catalogMetaById(catalog?.data ?? [])) : []),
    [allProducts, catalog, catalogReady],
  );
  /** Line numbers (0-based) submitted with a quantity but no cost. */
  const [missingCost, setMissingCost] = React.useState<number[]>([]);
  const productById = React.useMemo(
    () => new Map(allProducts.map((p) => [p.id, p])),
    [allProducts],
  );
  const unitsPerBoxFor = (productId: string) =>
    Number(productById.get(productId)?.unitsPerBox ?? 0);

  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const onScanAdd = (product: any, level?: SellLevel) => {
    const upb = Number(productById.get(product.id)?.unitsPerBox ?? product.unitsPerBox ?? 0);
    const next = addEntryUnit(linesRef.current, product, upb, level);
    if (next.lines === linesRef.current) return { created: false, refused: true };
    linesRef.current = next.lines;
    if (!productById.has(product.id))
      setPicked((l) => [
        ...l,
        { id: product.id, name: product.name, sku: product.sku, unitsPerBox: product.unitsPerBox },
      ]);
    setLines(next.lines);
    return { created: next.created };
  };

  const addLine = () => setLines((l) => [...l, emptyPOLine()]);
  const removeLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));
  const updateLine = (i: number, field: keyof POLineItem, val: string) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, [field]: val } : line)));

  const total = lines.reduce(
    (sum, l) => sum + resolvePOLineAmounts(l, unitsPerBoxFor(l.productId)).totalCost,
    0,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hasQty = (l: POLineItem) =>
      unitsPerBoxFor(l.productId) > 1 ? Number(l.boxes) > 0 || Number(l.pieces) > 0 : !!l.qty;
    const costless = lines.flatMap((l, i) => (l.productId && hasQty(l) && !l.unitCost ? [i] : []));
    setMissingCost(costless);
    if (costless.length > 0) {
      toast({
        title: "Validation",
        description: `Add a cost for line ${costless[0] + 1}.`,
        variant: "warning",
      });
      return;
    }
    const items = lines
      .filter((l) => {
        if (!l.productId || !l.unitCost) return false;
        const upb = unitsPerBoxFor(l.productId);
        return upb > 1 ? Number(l.boxes) > 0 || Number(l.pieces) > 0 : !!l.qty;
      })
      .map((l) => toCreateItem(l, unitsPerBoxFor(l.productId)));

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
      <div className={`${MODAL_PANEL} max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Create purchase order</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          onSubmit={handleSubmit}
          onKeyDown={(e) => {
            // Enter in a field (a scan, a quantity, a cost) never creates the order: only the button does.
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
          }}
          className={MODAL_FORM}
        >
          <div className={MODAL_BODY}>
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
                <label className="mb-1 block text-xs text-navy">Expected date</label>
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
              <PurchaseOrderScanBar
                disabled={!catalogReady}
                hint={
                  catalogReady
                    ? undefined
                    : catalogError && !catalogFetching
                      ? "Couldn't load products."
                      : "Loading products…"
                }
                onRetry={catalogError && !catalogFetching ? () => void refetchCatalog() : undefined}
                onAdd={onScanAdd}
                hasLine={(id) => lines.some((l) => l.productId === id)}
                addedIds={new Set(lines.map((l) => l.productId).filter(Boolean))}
              />
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-semibold text-navy">Line items</label>
                <button
                  type="button"
                  onClick={addLine}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
                >
                  <Plus className="h-3 w-3" /> Add Row
                </button>
              </div>

              <div className="rounded-lg border border-surface-border overflow-x-auto">
                <table className="min-w-[640px] w-full text-sm">
                  <thead className="bg-surface-raised text-xs text-navy/70">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Product</th>
                      <th className="px-3 py-2 text-left font-medium w-40">Qty</th>
                      <th className="px-3 py-2 text-left font-medium w-28">
                        Cost per {UW.pack.lower} / {UW.base.lower}
                      </th>
                      <th className="px-3 py-2 text-right font-medium w-24">Subtotal</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {lines.map((line, i) => {
                      const upb = unitsPerBoxFor(line.productId);
                      const isBoxed = upb > 1;
                      const { qty } = resolvePOLine(line, upb);
                      const subtotal = resolvePOLineAmounts(line, upb).totalCost;
                      return (
                        <tr key={i}>
                          <td className="px-3 py-2">
                            <select
                              name={`product-${i}`}
                              aria-label={`Product, line ${i + 1}`}
                              value={line.productId}
                              onChange={(e) => updateLine(i, "productId", e.target.value)}
                              className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <option value="">Select…</option>
                              {options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
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
                                  title={UW.pack.other}
                                  name={fieldName("boxes", i)}
                                  aria-label={`${UW.pack.other}, line ${i + 1}`}
                                  value={line.boxes}
                                  onChange={(e) => updateLine(i, "boxes", e.target.value)}
                                  className="w-full min-w-[3.5rem] rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                                />
                                <span className="text-navy/30">+</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={upb - 1}
                                  step={1}
                                  placeholder="0"
                                  title={`Extra ${UW.base.lowerOther}`}
                                  name={fieldName("pieces", i)}
                                  aria-label={`Extra ${UW.base.lowerOther}, line ${i + 1}`}
                                  value={line.pieces}
                                  onChange={(e) => updateLine(i, "pieces", e.target.value)}
                                  className="w-full min-w-[3.5rem] rounded border border-surface-border px-1.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                                />
                              </div>
                            ) : (
                              <input
                                type="number"
                                min={0.001}
                                step={0.001}
                                placeholder="0"
                                name={`qty-${i}`}
                                aria-label={`Quantity, line ${i + 1}`}
                                value={line.qty}
                                onChange={(e) => updateLine(i, "qty", e.target.value)}
                                className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                            )}
                            {isBoxed && (
                              <p className="mt-0.5 text-[10px] text-navy/50">
                                {UW.pack.lowerOther} + {UW.base.short.other} · {qty}{" "}
                                {UW.baseShortFor(qty)} total
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step={0.0001}
                              placeholder="0.00"
                              title={`Cost per ${isBoxed ? UW.pack.lower : UW.base.lower}`}
                              aria-label={`Cost per ${isBoxed ? UW.pack.lower : UW.base.lower}`}
                              name={`cost-${i}`}
                              value={line.unitCost}
                              onChange={(e) => updateLine(i, "unitCost", e.target.value)}
                              className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <p className="mt-0.5 text-[10px] text-navy/50">
                              per {isBoxed ? UW.pack.lower : UW.base.lower}
                            </p>
                            {missingCost.includes(i) && !line.unitCost && (
                              <p role="alert" className="mt-0.5 text-[11px] text-red-600">
                                Add a cost for line {i + 1}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-navy/70">
                            {subtotal > 0 ? formatMoney(subtotal) : "—"}
                          </td>
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              aria-label={`Remove line ${i + 1}`}
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
          </div>
          <div className={MODAL_FOOTER}>
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
