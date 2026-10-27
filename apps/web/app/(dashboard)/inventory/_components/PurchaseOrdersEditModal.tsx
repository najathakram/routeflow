"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  usePurchaseOrder,
  useUpdatePurchaseOrder,
  type UpdatePurchaseOrderInput,
} from "@/lib/api/inventory";
import type { PurchaseOrder, Supplier } from "./purchase-orders-shared";
import {
  buildUpdateItems,
  explainEditError,
  isReceived,
  linesChanged,
  toEditLine,
  validateEditLines,
  type EditLine,
} from "./purchase-orders-edit";
import { PurchaseOrderLinesTable, type CatalogProduct } from "./PurchaseOrderLinesTable";

/**
 * Escape, for this hand-rolled overlay (it is a bare `fixed inset-0` div, not the Radix Modal, so it
 * gets no Escape handling for free — W2 saw the key do nothing). The handler decides what Escape
 * means right now (Back on the prompt, close on the form, nothing while a save is in flight).
 */
function useEscape(handler: () => void) {
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      ref.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

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
function EditModalBody({
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

  // Escape = the same as the visible way out: Back on the Re-apply prompt, Cancel on the form.
  // Ignored while a save is in flight, so a half-sent PATCH is never abandoned mid-air.
  useEscape(() => {
    if (updatePO.isPending) return;
    if (pending) {
      setPending(null);
      setError(null);
    } else {
      onClose();
    }
  });

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
      // `items` is what makes the server run the reverse/re-post leg at all — a supplier
      // change on a received order sends the (unchanged) lines so its receipts are re-posted
      // under the new supplier; without them only the PO header would move.
      ...(changed || (received && supplierChanged) ? { items } : {}),
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
                  Expected date
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

            <PurchaseOrderLinesTable
              lines={lines}
              setLines={setLines}
              products={products}
              received={received}
              fallbackName={nameFor}
            />

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

/**
 * The exported modal loads what the form must be built from BEFORE it mounts:
 *  - the FRESH purchase order (the list row can be stale, and `items` is a full
 *    replacement — a line added since the list loaded would otherwise be deleted, and a
 *    line received since would have a stale floor), and
 *  - the product catalog (a boxed line's Boxes + Pieces / cost-per-box shape depends on
 *    `unitsPerBox`; building the form before it arrives would show per-piece figures that
 *    flip to per-box once it does).
 * The form is then built once from a frozen snapshot, so a background refetch can't
 * reshuffle it mid-edit.
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
  const { data: fresh, isError } = usePurchaseOrder(po.id);
  const snapshot = React.useRef<PurchaseOrder | null>(null);
  if (!snapshot.current && fresh && products.length > 0) snapshot.current = fresh as PurchaseOrder;
  // While loading (no body yet) Escape closes; once the body mounts it owns the key.
  useEscape(() => {
    if (!snapshot.current) onClose();
  });

  if (snapshot.current) {
    return (
      <EditModalBody
        po={snapshot.current}
        suppliers={suppliers}
        products={products}
        onClose={onClose}
      />
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
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
        <p role="status" className="px-6 py-8 text-center text-sm text-navy/70">
          {isError ? "Couldn't load this purchase order — close and try again." : "Loading…"}
        </p>
      </div>
    </div>
  );
}
