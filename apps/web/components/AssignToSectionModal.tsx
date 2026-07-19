"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  useTrackedCategories,
  useAssignProductsToCategory,
  useUnassignProductsFromCategory,
} from "@/lib/api/tracked-categories";

const NONE_VALUE = "__none__";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  products: Array<{ id: string; trackedCategoryId: string | null }>;
  onSuccess?: () => void;
}

/**
 * Bulk-assign the current products-page selection to a regulated section (or
 * remove them from one). Chrome mirrors `AssignProductsModal`.
 *
 * Assigning: one `assignProducts` call for every selected id — server-side
 * `updateMany` is idempotent for rows already in the target section (WP-A), so
 * we don't need to pre-filter.
 * Removing ("None"): products can each currently sit in a DIFFERENT section, and
 * `unassignProducts` is scoped to one section id, so we group the selection by
 * its current `trackedCategoryId` and issue one call per group (skipping
 * products that have no section already).
 */
export function AssignToSectionModal({ isOpen, onClose, products, onSuccess }: Props) {
  const { toast } = useToast();
  const { data: sections = [] } = useTrackedCategories({ active: true });
  const assign = useAssignProductsToCategory();
  const unassign = useUnassignProductsFromCategory();
  const [target, setTarget] = React.useState("");

  React.useEffect(() => {
    if (isOpen) setTarget("");
  }, [isOpen]);

  if (!isOpen) return null;

  const isPending = assign.isPending || unassign.isPending;

  const handleApply = async () => {
    if (!target) return;
    try {
      if (target === NONE_VALUE) {
        const groups = new Map<string, string[]>();
        for (const p of products) {
          if (!p.trackedCategoryId) continue;
          const ids = groups.get(p.trackedCategoryId) ?? [];
          ids.push(p.id);
          groups.set(p.trackedCategoryId, ids);
        }
        let unassignedCount = 0;
        for (const [sectionId, productIds] of Array.from(groups.entries())) {
          const res = await unassign.mutateAsync({ id: sectionId, productIds });
          unassignedCount += res.unassigned;
        }
        toast({
          title: "Products unassigned",
          description: `${unassignedCount} product${unassignedCount !== 1 ? "s" : ""} removed from their section`,
          variant: "success",
        });
      } else {
        const res = await assign.mutateAsync({
          id: target,
          productIds: products.map((p) => p.id),
        });
        toast({
          title: "Products assigned",
          description: `${res.assigned} product${res.assigned !== 1 ? "s" : ""} moved`,
          variant: "success",
        });
      }
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast({
        title: "Failed to update section",
        description: err?.response?.data?.message ?? "Please try again.",
        variant: "error",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Assign to section</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-6 py-4">
          <p className="text-sm text-navy/70">
            {products.length} product{products.length !== 1 ? "s" : ""} selected
          </p>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="" disabled>
              Choose a section…
            </option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NONE_VALUE}>None — remove from section</option>
          </select>
          <p className="text-xs text-navy/60">
            Products already in another section are moved; their subcategory is cleared.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply} disabled={!target} loading={isPending}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
