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
 * Bulk-assign the current products-page selection to a regulated type (or
 * remove them from one). Chrome mirrors `AssignProductsModal`.
 *
 * Assigning: one `assignProducts` call for every selected id — server-side
 * `updateMany` is idempotent for rows already in the target type (WP-A), so
 * we don't need to pre-filter.
 * Removing ("None"): products can each currently sit in a DIFFERENT type, and
 * `unassignProducts` is scoped to one type id, so we group the selection by
 * its current `trackedCategoryId` and issue one call per group (skipping
 * products that have no type already).
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
    const totalSelected = products.length;
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
        // Processed-vs-skipped (vendor-bills' shape). `unassigned` counts
        // MOVERS only — products that already carried no regulated type were
        // grouped out above and never sent, but they are a successful no-op,
        // not a skip. Count both populations as processed so a selection of
        // untyped products reads as success instead of "0 unassigned, N
        // skipped"; the remaining gap is the server not confirming a mover.
        const alreadyUnassigned = products.filter((p) => !p.trackedCategoryId).length;
        const processed = unassignedCount + alreadyUnassigned;
        const skipped = totalSelected - processed;
        toast({
          title: `${processed} product${processed !== 1 ? "s" : ""} unassigned${skipped > 0 ? `, ${skipped} skipped` : ""}`,
          description:
            skipped > 0
              ? "The server did not confirm every product in the selection."
              : alreadyUnassigned > 0
                ? `${alreadyUnassigned} already had no regulated type.`
                : "Removed from their regulated type",
          variant: processed > 0 ? "success" : "error",
        });
      } else {
        const res = await assign.mutateAsync({
          id: target,
          productIds: products.map((p) => p.id),
        });
        // `assigned` counts MOVERS only — rows already in the target type are
        // excluded from it although the server did process them. Reporting the
        // gap against it turns a fully successful re-assign into "0 assigned,
        // N skipped", so read the server's `processed` instead; the local
        // already-in-target tally is only the fallback for an older API (and
        // undercounts ids selected on a page this view never loaded).
        const alreadyInTarget = products.filter((p) => p.trackedCategoryId === target).length;
        const processed = res.processed ?? res.assigned + alreadyInTarget;
        const skipped = totalSelected - processed;
        const unchanged = processed - res.assigned;
        toast({
          title: `${processed} product${processed !== 1 ? "s" : ""} assigned${skipped > 0 ? `, ${skipped} skipped` : ""}`,
          description:
            skipped > 0
              ? "The server did not confirm every product in the selection."
              : unchanged > 0
                ? `${unchanged} already had this regulated type.`
                : undefined,
          variant: processed > 0 ? "success" : "error",
        });
      }
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast({
        title: "Failed to update regulated type",
        description: err?.response?.data?.message ?? "Please try again.",
        variant: "error",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Assign to regulated type</h2>
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
              Choose a regulated type…
            </option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NONE_VALUE}>None — remove regulated type</option>
          </select>
          <p className="text-xs text-navy/60">
            Products already assigned elsewhere are moved between types; their category is
            re-synced.
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
