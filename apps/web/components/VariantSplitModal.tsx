"use client";

import * as React from "react";
import Link from "next/link";
import { X, ArrowRightLeft, Search, CheckCircle2, AlertCircle } from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import { normalizeBoxesPieces, roundUnitCost } from "@/lib/pricing";
import { useProduct, type CostingMethod } from "@/lib/api/products";
import {
  useAssignToVariants,
  type VariantAssignmentInput,
  type VariantAssignResult,
} from "@/lib/api/variant-assign";

/**
 * Move stock from a generic parent product to its variants — partial or
 * complete, existing variants and/or ones created inline. ONE reusable
 * component; every entry point (product detail, inventory Stock tab,
 * vendor-bill line) renders this exact modal so behaviour never diverges.
 *
 * Hand-rolled overlay (not the shared `Modal` from `@routeflow/ui/web`,
 * which caps at `max-w-lg`) — same convention as `GroupAsVariantsModal.tsx`,
 * the closest existing precedent for a multi-row split form.
 *
 * "Unassigned stock" is not new state — it's simply the parent's own
 * `currentStock`. The `pool` prop is just this session's assignable ceiling;
 * it defaults to that stock figure, but the vendor-bill entry point passes
 * just the qty received on that particular line instead, so the split UI
 * reflects what's on THIS bill rather than any other unassigned stock
 * already sitting on the parent.
 */

/**
 * Minimal parent shape this modal needs. Satisfied by the product detail
 * page's `ApiProduct`, the inventory Stock tab's row type, and a vendor-bill
 * line's mapped product (once the caller adds averageCost/unitsPerBox/
 * costingMethod alongside the line's own id/name/currentStock).
 */
export interface VariantSplitParent {
  id: string;
  name: string;
  currentStock: number;
  averageCost?: string | number | null;
  unitsPerBox?: number | null;
  costingMethod?: CostingMethod;
}

/**
 * One of the parent's existing children, as embedded on `GET /products/:id`
 * (`ProductsService.findOne` includes the full `variants` relation).
 */
interface VariantChild {
  id: string;
  name: string;
  sku?: string | null;
  variantName?: string | null;
  currentStock: number;
  isActive?: boolean;
}

interface RowState {
  /** Used when the parent isn't boxed (unitsPerBox <= 1). */
  qty: number;
  /** Used when the parent IS boxed. */
  boxes: number;
  pieces: number;
  costEnabled: boolean;
  /** Raw text of the per-row cost override input. */
  cost: string;
}

const EMPTY_ROW: RowState = { qty: 0, boxes: 0, pieces: 0, costEnabled: false, cost: "" };

/** Row id used for the inline "new variant" row in the clamp/remaining math. */
const NEW_ROW_ID = "__new__";

interface VariantSplitModalProps {
  parent: VariantSplitParent;
  /** Assignable ceiling for this session — defaults to the parent's own
   *  `currentStock` ("unassigned stock"). */
  pool?: number;
  onClose: () => void;
  /** Fired when the operator DISMISSES the success view — not the instant the
   *  assignment lands. Entry points close the modal from this callback, so
   *  firing it on the response would unmount the modal in the same React tick
   *  as `setResult`, and the success view (with its movements link) would
   *  never paint. Cache invalidation is the mutation hook's job, so nothing
   *  needs this any earlier. */
  onSuccess?: (result: VariantAssignResult) => void;
}

export function VariantSplitModal({ parent, pool, onClose, onSuccess }: VariantSplitModalProps) {
  const { toast } = useToast();
  const { data: parentDetail, isLoading: loadingVariants } = useProduct(parent.id);
  const assignToVariants = useAssignToVariants();

  // ACTIVE children only. `GET /products/:id` includes deactivated variants
  // too (it only sorts `isActive desc`), and the server rejects an inactive
  // target — offering one here would just be a row that 400s, or worse, look
  // like a valid home for stock that no sellable surface would ever show.
  const variants: VariantChild[] = React.useMemo(
    () =>
      ((parentDetail as { variants?: VariantChild[] } | undefined)?.variants ?? []).filter(
        (v) => v.isActive !== false,
      ),
    [parentDetail],
  );

  const unitsPerBox = Number(parent.unitsPerBox ?? 0);
  const isBoxed = unitsPerBox > 1;
  const isStandardParent = parent.costingMethod === "STANDARD";
  const parentUnitCost =
    parent.averageCost != null && parent.averageCost !== "" ? Number(parent.averageCost) : null;
  const totalPool = pool ?? (Number(parent.currentStock) || 0);

  const [search, setSearch] = React.useState("");
  const [rows, setRows] = React.useState<Record<string, RowState>>({});
  const [newRow, setNewRow] = React.useState<RowState>(EMPTY_ROW);
  const [newName, setNewName] = React.useState("");
  const [result, setResult] = React.useState<VariantAssignResult | null>(null);

  /** Looks up an EXISTING variant's row state — the new-variant row lives in
   *  its own `newRow` state and is read directly, never through this. */
  const getRow = React.useCallback((id: string): RowState => rows[id] ?? EMPTY_ROW, [rows]);

  const rowQty = React.useCallback(
    (row: RowState): number =>
      isBoxed
        ? normalizeBoxesPieces({ boxes: row.boxes, pieces: row.pieces, unitsPerBox }).qty
        : Math.max(0, Math.trunc(row.qty)),
    [isBoxed, unitsPerBox],
  );

  const assignedTotal = Object.values(rows).reduce((sum, r) => sum + rowQty(r), 0) + rowQty(newRow);
  const remaining = Math.max(0, totalPool - assignedTotal);

  /**
   * Clamp one row's candidate quantity to what's left once every OTHER row's
   * current assignment is subtracted from the pool — the live
   * "over-assignment is blocked" rule.
   */
  const clampFor = React.useCallback(
    (rowId: string, candidateQty: number): number => {
      const othersFromRows = Object.entries(rows).reduce(
        (sum, [id, r]) => (id === rowId ? sum : sum + rowQty(r)),
        0,
      );
      const othersFromNew = rowId === NEW_ROW_ID ? 0 : rowQty(newRow);
      const available = Math.max(0, totalPool - othersFromRows - othersFromNew);
      return Math.min(Math.max(0, Math.trunc(candidateQty)), available);
    },
    [rows, newRow, rowQty, totalPool],
  );

  const applyRow = (id: string, patch: Partial<RowState>) => {
    if (id === NEW_ROW_ID) {
      setNewRow((prev) => ({ ...prev, ...patch }));
    } else {
      setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ROW), ...patch } }));
    }
  };

  const setRowBoxesPieces = (id: string, boxes: number, pieces: number) => {
    const candidate = normalizeBoxesPieces({ boxes, pieces, unitsPerBox }).qty;
    const clamped = clampFor(id, candidate);
    const normalized = normalizeBoxesPieces({ qty: clamped, unitsPerBox });
    applyRow(id, { boxes: normalized.boxes ?? 0, pieces: normalized.pieces ?? 0 });
  };

  const setRowQty = (id: string, qty: number) => {
    applyRow(id, { qty: clampFor(id, qty) });
  };

  const visibleVariants = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return variants;
    return variants.filter((v) => {
      const label = (v.variantName ?? v.name ?? "").toLowerCase();
      return label.includes(q) || (v.sku ?? "").toLowerCase().includes(q);
    });
  }, [variants, search]);

  const buildAssignments = (): VariantAssignmentInput[] => {
    const out: VariantAssignmentInput[] = [];

    const addRow = (
      row: RowState,
      target: { productId: string } | { newVariant: { name: string } },
    ) => {
      const qty = rowQty(row);
      if (qty <= 0) return;
      const entry: VariantAssignmentInput = { ...target };
      if (isBoxed) {
        entry.boxes = row.boxes;
        entry.pieces = row.pieces;
      } else {
        entry.qty = qty;
      }
      if (!isStandardParent && row.costEnabled && row.cost.trim() !== "") {
        const c = Number(row.cost);
        if (Number.isFinite(c) && c >= 0) entry.unitCostOverride = roundUnitCost(c);
      }
      out.push(entry);
    };

    for (const v of variants) {
      const row = rows[v.id];
      if (row) addRow(row, { productId: v.id });
    }

    const trimmedName = newName.trim();
    if (trimmedName) addRow(newRow, { newVariant: { name: trimmedName } });

    return out;
  };

  const assignments = buildAssignments();
  const canSubmit = assignedTotal > 0 && assignments.length > 0 && !assignToVariants.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      const res = await assignToVariants.mutateAsync({
        parentProductId: parent.id,
        assignments,
      });
      const movedQty = res.assignments.reduce((s, a) => s + Number(a.qty), 0);
      toast({
        title: `Assigned ${res.assignments.length} variant${res.assignments.length === 1 ? "" : "s"}`,
        description: `${movedQty} unit${movedQty === 1 ? "" : "s"} moved off "${parent.name}".`,
        variant: "success",
      });
      setResult(res);
    } catch (err: any) {
      toast({
        title: "Couldn't assign stock",
        description: err?.response?.data?.message ?? "Please try again.",
        variant: "error",
      });
    }
  };

  // ─── Success view ─────────────────────────────────────────────────────────
  if (result) {
    const movedQty = result.assignments.reduce((s, a) => s + Number(a.qty), 0);
    /** Dismissing the success view is what closes the modal — only then does
     *  the entry point get told the split happened. */
    const handleDone = () => {
      onSuccess?.(result);
      onClose();
    };
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
        <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              <h2 className="text-base font-semibold text-navy">Stock assigned</h2>
            </div>
            <button
              type="button"
              onClick={handleDone}
              className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <p className="mb-4 text-sm text-navy/70">
              Moved {movedQty} unit{movedQty === 1 ? "" : "s"} off{" "}
              <span className="font-medium text-navy">{parent.name}</span> into{" "}
              {result.assignments.length} variant{result.assignments.length === 1 ? "" : "s"}.{" "}
              {result.parentRemaining} remain unassigned.
            </p>

            <div className="overflow-hidden rounded-lg border border-surface-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border bg-surface-raised text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                      Variant
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                      Qty
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                      Unit cost
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {result.assignments.map((a) => (
                    <tr key={a.productId}>
                      <td className="px-3 py-2 text-navy">
                        {a.variantName}
                        {a.created && (
                          <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-brand-600">
                            new
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-navy">
                        {a.qty}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-navy">
                        ${Number(a.unitCost).toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3">
              <Link
                href={`/inventory/movements?reference=${encodeURIComponent(result.reference)}`}
                className="text-sm text-brand-600 hover:text-brand-700 hover:underline"
              >
                View the movements this split wrote →
              </Link>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-surface-border px-6 py-4">
            <Button onClick={handleDone}>Done</Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Form view ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-brand-500" />
            <div>
              <h2 className="text-base font-semibold text-navy">Assign to variants</h2>
              <p className="text-xs text-navy/70">{parent.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
                remaining > 0 ? "bg-brand-50 text-brand-700" : "bg-surface-raised text-navy/70",
              )}
            >
              Remaining: {remaining}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {totalPool <= 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Nothing unassigned to split — there is no pool to draw from right now.</span>
            </div>
          )}

          <div className="mb-3 flex items-center gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-navy/70" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search variants…"
              className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none"
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-surface-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                    Variant
                  </th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                    Qty to assign
                  </th>
                  {!isStandardParent && (
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                      Cost
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {visibleVariants.length === 0 && loadingVariants ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-xs text-navy/70">
                      Loading variants…
                    </td>
                  </tr>
                ) : visibleVariants.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-xs text-navy/70">
                      {search.trim() ? "No matches." : "No variants yet — add one below."}
                    </td>
                  </tr>
                ) : (
                  visibleVariants.map((v) => {
                    const row = getRow(v.id);
                    return (
                      <tr key={v.id} className="align-top">
                        <td className="px-3 py-2">
                          <div className="text-sm text-navy">{v.variantName || v.name}</div>
                          {v.sku && <div className="text-[11px] text-navy/70">SKU: {v.sku}</div>}
                        </td>
                        <td className="px-3 py-2">
                          {isBoxed ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min={0}
                                value={row.boxes}
                                onChange={(e) =>
                                  setRowBoxesPieces(
                                    v.id,
                                    parseInt(e.target.value, 10) || 0,
                                    row.pieces,
                                  )
                                }
                                onFocus={(e) => e.target.select()}
                                className="w-14 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                                title="Number of whole cases"
                              />
                              <span className="text-xs text-navy/70">cases</span>
                              <span className="text-xs text-navy/30">+</span>
                              <input
                                type="number"
                                min={0}
                                max={unitsPerBox - 1}
                                value={row.pieces}
                                onChange={(e) =>
                                  setRowBoxesPieces(
                                    v.id,
                                    row.boxes,
                                    parseInt(e.target.value, 10) || 0,
                                  )
                                }
                                onFocus={(e) => e.target.select()}
                                className="w-14 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                                title="Extra loose units (less than a full case)"
                              />
                              <span className="text-xs text-navy/70">units</span>
                            </div>
                          ) : (
                            <input
                              type="number"
                              min={0}
                              value={row.qty}
                              onChange={(e) => setRowQty(v.id, parseInt(e.target.value, 10) || 0)}
                              onFocus={(e) => e.target.select()}
                              className="w-20 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                          )}
                        </td>
                        {!isStandardParent && (
                          <td className="px-3 py-2">
                            {row.costEnabled ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-navy/70">$</span>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.0001}
                                  value={row.cost}
                                  onChange={(e) => applyRow(v.id, { cost: e.target.value })}
                                  placeholder={
                                    parentUnitCost != null ? parentUnitCost.toFixed(4) : "0.0000"
                                  }
                                  className="w-24 rounded border border-surface-border px-1.5 py-1 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                                />
                                <button
                                  type="button"
                                  onClick={() => applyRow(v.id, { costEnabled: false, cost: "" })}
                                  className="text-navy/30 hover:text-navy"
                                  title="Use the generic's cost"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => applyRow(v.id, { costEnabled: true })}
                                className="text-xs text-brand-600 hover:underline"
                              >
                                Different cost?
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}

                {/* Inline new-variant row — created via products.service.create()'s
                    inheritance server-side; everything but the name comes from
                    the parent. */}
                <tr className="align-top bg-brand-50/30">
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      maxLength={120}
                      placeholder="+ New variant name"
                      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {isBoxed ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          value={newRow.boxes}
                          onChange={(e) =>
                            setRowBoxesPieces(
                              NEW_ROW_ID,
                              parseInt(e.target.value, 10) || 0,
                              newRow.pieces,
                            )
                          }
                          onFocus={(e) => e.target.select()}
                          className="w-14 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                          title="Number of whole cases"
                        />
                        <span className="text-xs text-navy/70">cases</span>
                        <span className="text-xs text-navy/30">+</span>
                        <input
                          type="number"
                          min={0}
                          max={unitsPerBox - 1}
                          value={newRow.pieces}
                          onChange={(e) =>
                            setRowBoxesPieces(
                              NEW_ROW_ID,
                              newRow.boxes,
                              parseInt(e.target.value, 10) || 0,
                            )
                          }
                          onFocus={(e) => e.target.select()}
                          className="w-14 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                          title="Extra loose units (less than a full case)"
                        />
                        <span className="text-xs text-navy/70">units</span>
                      </div>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        value={newRow.qty}
                        onChange={(e) => setRowQty(NEW_ROW_ID, parseInt(e.target.value, 10) || 0)}
                        onFocus={(e) => e.target.select()}
                        className="w-20 rounded border border-surface-border px-1.5 py-1 text-center text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    )}
                  </td>
                  {!isStandardParent && (
                    <td className="px-3 py-2">
                      {newRow.costEnabled ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-navy/70">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.0001}
                            value={newRow.cost}
                            onChange={(e) => applyRow(NEW_ROW_ID, { cost: e.target.value })}
                            placeholder={
                              parentUnitCost != null ? parentUnitCost.toFixed(4) : "0.0000"
                            }
                            className="w-24 rounded border border-surface-border px-1.5 py-1 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                          <button
                            type="button"
                            onClick={() => applyRow(NEW_ROW_ID, { costEnabled: false, cost: "" })}
                            className="text-navy/30 hover:text-navy"
                            title="Use the generic's cost"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => applyRow(NEW_ROW_ID, { costEnabled: true })}
                          className="text-xs text-brand-600 hover:underline"
                        >
                          Different cost?
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-navy/70">
            {isStandardParent
              ? `"${parent.name}" is STANDARD-costed — its cost is operator-set and stays fixed; variants keep their own STANDARD cost unaffected by this transfer.`
              : "Leave a variant's cost blank to inherit the generic's average cost."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={assignToVariants.isPending}
            disabled={!canSubmit}
          >
            {assignedTotal > 0
              ? `Assign ${assignedTotal} unit${assignedTotal === 1 ? "" : "s"}`
              : "Assign"}
          </Button>
        </div>
      </div>
    </div>
  );
}
