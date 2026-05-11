"use client";

import * as React from "react";
import { X, GitBranch, AlertCircle, ArrowRight } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  useProducts,
  useBulkAssignParent,
  type BulkAssignParentResult,
} from "@/lib/api/products";
import { SearchableProductPicker } from "./SearchableProductPicker";

interface ProductLite {
  id: string;
  name: string;
  sku?: string;
  parentProductId?: string | null;
  variantName?: string | null;
  isActive?: boolean;
}

interface GroupAsVariantsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** IDs of the products selected on the list page */
  selectedIds: string[];
  /** Optional callback after a successful run — list page can clear its selection */
  onSuccess?: (result: BulkAssignParentResult) => void;
}

/**
 * Bulk-promote multiple existing standalone products to variants of a chosen
 * parent. Lets the operator fix a catalog where each flavor was entered as
 * its own standalone product, without re-creating anything.
 *
 * For each selected product, we suggest a `variantName` by stripping the
 * parent's name + a separator from the start of the product's name. The
 * operator can override per-row before saving.
 */
const SEPARATORS = [" - ", " — ", " – ", ": ", " "];

function suggestVariantName(productName: string, parentName: string): string {
  if (!parentName) return productName;
  const lcName = productName.toLowerCase();
  const lcParent = parentName.toLowerCase();
  if (!lcName.startsWith(lcParent)) return productName;
  const remainder = productName.slice(parentName.length);
  // Strip the leading separator if present
  for (const sep of SEPARATORS) {
    if (remainder.startsWith(sep)) {
      return remainder.slice(sep.length).trim();
    }
  }
  return remainder.trim() || productName;
}

export function GroupAsVariantsModal({
  isOpen,
  onClose,
  selectedIds,
  onSuccess,
}: GroupAsVariantsModalProps) {
  const { toast } = useToast();
  const { data: allProductsData } = useProducts({ limit: 0 });
  const allProducts: ProductLite[] = allProductsData?.data ?? [];
  const bulkAssign = useBulkAssignParent();

  const [parentId, setParentId] = React.useState("");
  // Per-row override of the suggested variant name
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (isOpen) {
      setParentId("");
      setOverrides({});
    }
  }, [isOpen]);

  // Children-to-be: only include selected products that aren't already
  // variants of something (re-parenting is allowed but worth surfacing).
  const selectedProducts = allProducts.filter((p) => selectedIds.includes(p.id));
  const parent = allProducts.find((p) => p.id === parentId);

  // The picker should hide products that are themselves children of another
  // parent (can't be a parent), and the products we're about to move.
  const standaloneCandidates = allProducts.filter((p) => !p.parentProductId);

  const alreadyVariantCount = selectedProducts.filter(
    (p) => !!p.parentProductId,
  ).length;

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!parentId) {
      toast({ title: "Pick a parent product first", variant: "error" });
      return;
    }
    if (selectedIds.includes(parentId)) {
      toast({
        title: "Parent can't be in the selection",
        description: "Deselect the parent product on the list and try again.",
        variant: "error",
      });
      return;
    }
    const assignments = selectedProducts.map((p) => ({
      id: p.id,
      variantName:
        overrides[p.id]?.trim() ||
        suggestVariantName(p.name, parent?.name ?? "") ||
        p.name,
    }));
    const result = await bulkAssign.mutateAsync({
      parentProductId: parentId,
      assignments,
    });
    if (result.failed.length === 0) {
      toast({
        title: `Grouped ${result.succeeded.length} product${result.succeeded.length === 1 ? "" : "s"}`,
        description: `All now appear as variants of "${parent?.name}".`,
        variant: "success",
      });
      onSuccess?.(result);
      onClose();
    } else {
      toast({
        title: `${result.succeeded.length} grouped, ${result.failed.length} failed`,
        description: result.failed
          .slice(0, 3)
          .map((f) => f.reason)
          .join("; "),
        variant: "error",
      });
      onSuccess?.(result);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-brand-500" />
            <h2 className="text-base font-semibold text-navy">
              Group {selectedIds.length} product{selectedIds.length === 1 ? "" : "s"} as variants
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="mb-4 text-sm text-navy/60">
            Pick the standalone product these should become variants of. Each
            selected product gets a flavor / variety name (auto-derived from
            its current name; you can override below).
          </p>

          {/* Parent picker */}
          <div className="mb-4">
            <label className="mb-1 block text-xs font-medium text-navy">
              Variant of <span className="text-danger">*</span>
            </label>
            <SearchableProductPicker
              value={parentId}
              onChange={setParentId}
              products={standaloneCandidates}
              excludeIds={selectedIds}
              placeholder="Type to search standalone products…"
              emptyHint="No standalone products available — every product is already a variant."
            />
            {parent && (
              <p className="mt-1.5 rounded bg-brand-50 px-2.5 py-1.5 text-xs text-brand-700">
                Parent: <span className="font-semibold">{parent.name}</span>
              </p>
            )}
          </div>

          {/* Warning if any selected products are already variants */}
          {alreadyVariantCount > 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {alreadyVariantCount} of the selected products are already
                variants of another parent. Saving will re-parent them.
              </span>
            </div>
          )}

          {/* Per-row preview + override */}
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-navy/50">
            Variant names
          </div>
          <div className="overflow-hidden rounded-lg border border-surface-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                    Current name
                  </th>
                  <th className="w-10 px-2 py-2" />
                  <th className="w-1/3 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
                    Variant name
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {selectedProducts.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-xs text-navy/50">
                      No products selected.
                    </td>
                  </tr>
                ) : (
                  selectedProducts.map((p) => {
                    const suggested = suggestVariantName(p.name, parent?.name ?? "");
                    const value = overrides[p.id] ?? suggested;
                    return (
                      <tr key={p.id} className="align-top">
                        <td className="px-3 py-2">
                          <div className="text-sm text-navy" title={p.name}>
                            {p.name}
                          </div>
                          {p.sku && (
                            <div className="text-[11px] text-navy/40">
                              SKU: {p.sku}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center text-navy/30">
                          <ArrowRight className="inline h-3 w-3" />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            placeholder="e.g. Strawberry"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-navy/50">
            The product name itself isn&apos;t renamed — only the
            <span className="mx-1 font-mono text-navy">parentProductId</span>
            and
            <span className="mx-1 font-mono text-navy">variantName</span>
            fields are set. You can revert any of these from the product detail
            page later.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={bulkAssign.isPending}
            disabled={!parentId || selectedProducts.length === 0}
          >
            Group as variants
          </Button>
        </div>
      </div>
    </div>
  );
}
