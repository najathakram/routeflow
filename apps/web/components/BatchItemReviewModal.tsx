"use client";

import * as React from "react";
import { X, Sparkles, Check, Plus } from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import { SupplierSelect } from "./SupplierSelect";
import { SearchableProductPicker } from "./SearchableProductPicker";
import { ProductCreateModal } from "./ProductCreateModal";
import { useSuppliers } from "@/lib/api/inventory";
import { displayProductName } from "@/lib/product-display";
import {
  useResolveItem,
  useUpdateBatchItem,
  type ImportQueueItem,
  type UpdateBatchItemLinePatch,
} from "@/lib/api/batch-import";

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

interface Props {
  batchId: string;
  item: ImportQueueItem;
  onClose: () => void;
}

/**
 * The fix for "Mark resolved" being a blind rubber stamp: unmatched lines
 * and an unlinked supplier used to post silently (skipping stock/cost
 * updates and leaving the bill supplier-less). This modal is now the ONLY
 * way those get cleared — each line must be explicitly mapped to a product
 * or dismissed as a custom line before `resolveItem` will accept the item.
 */
export function BatchItemReviewModal({ batchId, item, onClose }: Props) {
  const { toast } = useToast();
  const { data: suppliersData } = useSuppliers();
  const suppliers = (suppliersData as { id: string; name: string }[] | undefined) ?? [];

  const updateItem = useUpdateBatchItem();
  const resolveItem = useResolveItem();

  const [supplierId, setSupplierId] = React.useState(item.supplierMatchId ?? "");
  // Local per-line decisions since the last save: productId picked, or "keep as custom".
  const [picks, setPicks] = React.useState<Record<number, string>>({});
  const [pickLabels, setPickLabels] = React.useState<Record<number, string>>({});
  const [customized, setCustomized] = React.useState<Record<number, boolean>>({});
  // Index of the line the operator is creating a brand-new product for, if any.
  const [createFromRow, setCreateFromRow] = React.useState<number | null>(null);

  const payload = item.extractedPayload;
  const lines = payload?.items ?? [];
  const pendingIndexes = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !l.matchedProductId && !l.reviewed)
    .map(({ i }) => i);

  const dirtyLines: UpdateBatchItemLinePatch[] = pendingIndexes
    .filter((i) => picks[i] || customized[i])
    .map((i) =>
      customized[i] ? { index: i, keepCustom: true } : { index: i, productId: picks[i] },
    );

  const supplierDirty = Boolean(
    item.supplierUnresolved && supplierId && supplierId !== item.supplierMatchId,
  );
  const canSave = dirtyLines.length > 0 || supplierDirty;
  const stillUnresolved =
    pendingIndexes.length > dirtyLines.length || (item.supplierUnresolved && !supplierDirty);

  const handleSave = () => {
    updateItem.mutate(
      {
        batchId,
        itemId: item.id,
        ...(supplierDirty ? { supplierId } : {}),
        ...(dirtyLines.length ? { lines: dirtyLines } : {}),
      },
      {
        onSuccess: () => {
          setPicks({});
          setCustomized({});
          toast({ title: "Saved", variant: "success" });
        },
        onError: (e: any) =>
          toast({
            title: "Couldn't save",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );
  };

  const handleResolve = () => {
    resolveItem.mutate(
      { batchId, itemId: item.id },
      {
        onSuccess: () => {
          toast({ title: "Marked resolved — ready to post", variant: "success" });
          onClose();
        },
        onError: (e: any) =>
          toast({
            title: "Couldn't resolve",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );
  };

  const isPending = updateItem.isPending || resolveItem.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-brand-500" />
            <h2 className="text-lg font-semibold text-navy">
              Review — {item.supplierName ?? item.filename ?? "Invoice"}
              {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {item.supplierUnresolved && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                Supplier <span className="text-danger">*</span>
              </label>
              <SupplierSelect value={supplierId} onChange={setSupplierId} suppliers={suppliers} />
              <p className="mt-1 text-xs text-navy/70">
                Detected &ldquo;{item.supplierName}&rdquo; but couldn&apos;t match it to one
                supplier — pick the right one.
              </p>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-navy">
              Line items
              {pendingIndexes.length > 0 && (
                <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                  {pendingIndexes.length} need review
                </span>
              )}
            </h3>
            <div className="space-y-2">
              {lines.map((line, i) => {
                const needsReview = pendingIndexes.includes(i);
                if (!needsReview) {
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised/40 px-3 py-2 text-sm"
                    >
                      <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                      <span className="flex-1 truncate text-navy" title={line.extractedName}>
                        {line.matchedProductName ?? line.extractedName ?? "Custom line"}
                      </span>
                      <span className="shrink-0 text-navy/70">
                        {line.qty} × {fmt(line.unitCost)}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={i}
                    data-testid={`review-line-${i}`}
                    className="rounded-lg border border-amber-200 bg-amber-50/50 p-3"
                  >
                    <p
                      className="mb-1.5 truncate text-sm font-medium text-navy"
                      title={line.extractedName}
                    >
                      {line.extractedName ?? "Unnamed line"}
                      <span className="ml-2 font-normal text-navy/70">
                        {line.qty} × {fmt(line.unitCost)}
                      </span>
                    </p>
                    {customized[i] ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-1.5">
                        <span className="text-xs text-navy/70">
                          Kept as a custom line — won&apos;t update stock or costs
                        </span>
                        <button
                          type="button"
                          onClick={() => setCustomized((c) => ({ ...c, [i]: false }))}
                          className="text-xs font-medium text-brand-600 hover:underline"
                        >
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <SearchableProductPicker
                            async
                            value={picks[i] ?? ""}
                            selectedLabel={
                              pickLabels[i] ?? line.matchedProductName ?? line.extractedName
                            }
                            onChange={(id, product) => {
                              setPicks((p) => ({ ...p, [i]: id }));
                              setPickLabels((l) => ({
                                ...l,
                                [i]: product ? displayProductName(product) : "",
                              }));
                            }}
                            className="flex-1"
                            placeholder="Link to a product…"
                          />
                          {!picks[i] && (
                            <button
                              type="button"
                              onClick={() => setCreateFromRow(i)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-surface-border text-brand-600 transition-colors hover:bg-brand-50"
                              title="Add as new product"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setCustomized((c) => ({ ...c, [i]: true }))}
                            className="shrink-0 rounded-lg border border-surface-border px-2.5 py-1.5 text-xs font-medium text-navy transition-colors hover:bg-white"
                          >
                            Keep custom
                          </button>
                        </div>
                        {!picks[i] && line.candidates && line.candidates.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {line.candidates.slice(0, 3).map((c) => (
                              <button
                                key={c.productId}
                                type="button"
                                onClick={() => {
                                  setPicks((p) => ({ ...p, [i]: c.productId }));
                                  setPickLabels((l) => ({ ...l, [i]: c.name }));
                                }}
                                className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100"
                              >
                                Did you mean {c.name}? ({Math.round(c.score * 100)}%)
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
          <span className="text-xs text-navy/70">
            {stillUnresolved
              ? "Save your changes, then resolve once everything is decided."
              : "Everything's decided — ready to resolve."}
          </span>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {canSave && (
              <Button variant="secondary" onClick={handleSave} disabled={isPending}>
                {updateItem.isPending ? "Saving…" : "Save"}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleResolve}
              disabled={isPending || stillUnresolved || canSave}
              className={cn((stillUnresolved || canSave) && "opacity-40")}
            >
              {resolveItem.isPending ? "Resolving…" : "Mark resolved"}
            </Button>
          </div>
        </div>
      </div>

      {createFromRow != null && (
        <ProductCreateModal
          isOpen
          onClose={() => setCreateFromRow(null)}
          onCreated={(product) => {
            setPicks((p) => ({ ...p, [createFromRow]: product.id }));
            setPickLabels((l) => ({ ...l, [createFromRow]: product.name }));
            setCreateFromRow(null);
          }}
          initialName={lines[createFromRow]?.extractedName ?? undefined}
          initialSku={lines[createFromRow]?.sku ?? undefined}
          initialPrice={
            lines[createFromRow]?.unitCost != null
              ? lines[createFromRow].unitCost! * 1.3
              : undefined
          }
          initialCost={lines[createFromRow]?.unitCost ?? undefined}
        />
      )}
    </div>
  );
}
