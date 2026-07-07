"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import {
  useTrackedCategories,
  useAssignProductsToCategory,
  useUnassignProductsFromCategory,
  type TrackedCategory,
} from "@/lib/api/tracked-categories";

const inputCls =
  "w-full rounded border border-surface-border py-2 pl-9 pr-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  category: TrackedCategory | null;
}

/**
 * Bulk-assign products to a tracked category. A product belongs to at most one
 * category, so checking a product currently in another category MOVES it here.
 */
export function AssignProductsModal({ isOpen, onClose, category }: Props) {
  const { toast } = useToast();
  const { data: productsData, isLoading } = useProducts({ limit: 0 });
  const { data: categories = [] } = useTrackedCategories();
  const assign = useAssignProductsToCategory();
  const unassign = useUnassignProductsFromCategory();

  // Include ALL products, variants included — `trackedCategoryId` is a per-row
  // scalar (a variant can be independently regulated) and `productCount` counts
  // every row, so the list must too or the count can't reconcile.
  const products = React.useMemo(() => productsData?.data ?? [], [productsData]);
  const nameById = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of products) m[p.id] = p.name;
    return m;
  }, [products]);
  // Variants store only their own name (e.g. "Strawberry"); compose parent context.
  const displayName = React.useCallback(
    (p: any) =>
      p.parentProductId && nameById[p.parentProductId]
        ? `${nameById[p.parentProductId]} · ${p.name}`
        : p.name,
    [nameById],
  );
  const catName = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of categories) m[c.id] = c.name;
    return m;
  }, [categories]);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState("");

  // Seed the selection from current membership ONCE per open (after products load).
  // Guarded by a ref so a later products refetch (e.g. our own save invalidation)
  // doesn't clobber the operator's in-progress checkboxes.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!isOpen) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !category || isLoading) return;
    setSelected(
      new Set<string>(
        products.filter((p: any) => p.trackedCategoryId === category.id).map((p: any) => p.id),
      ),
    );
    setSearch("");
    seeded.current = true;
  }, [isOpen, category, products, isLoading]);

  if (!isOpen || !category) return null;

  const q = search.trim().toLowerCase();
  const visible = q
    ? products.filter(
        (p: any) =>
          displayName(p).toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q),
      )
    : products;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleSave = async () => {
    const toAssign = products
      .filter((p: any) => selected.has(p.id) && p.trackedCategoryId !== category.id)
      .map((p: any) => p.id);
    const toUnassign = products
      .filter((p: any) => !selected.has(p.id) && p.trackedCategoryId === category.id)
      .map((p: any) => p.id);

    if (toAssign.length === 0 && toUnassign.length === 0) {
      onClose();
      return;
    }
    try {
      if (toAssign.length) await assign.mutateAsync({ id: category.id, productIds: toAssign });
      if (toUnassign.length)
        await unassign.mutateAsync({ id: category.id, productIds: toUnassign });
      toast({
        title: "Products updated",
        description: `${toAssign.length} added · ${toUnassign.length} removed`,
        variant: "success",
      });
      onClose();
    } catch (err: any) {
      toast({
        title: "Failed to update products",
        description: err?.response?.data?.message ?? "Please try again.",
        variant: "error",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">
            Products in <span className="text-brand-600">{category.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-surface-border px-6 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={inputCls}
              placeholder="Search products…"
            />
          </div>
          <p className="mt-2 text-xs text-navy/60">
            {selected.size} selected · checking a product in another category moves it here.
          </p>
        </div>

        <div className="min-h-[8rem] flex-1 overflow-y-auto px-3 py-2">
          {isLoading ? (
            <div className="h-24 animate-pulse rounded-lg bg-surface-raised" />
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-navy/60">No products match.</p>
          ) : (
            visible.map((p: any) => {
              const otherCat =
                p.trackedCategoryId && p.trackedCategoryId !== category.id
                  ? catName[p.trackedCategoryId]
                  : null;
              return (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-raised/60"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-4 w-4 rounded border-surface-border accent-brand-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-navy">{displayName(p)}</span>
                    {p.sku && <span className="block truncate text-xs text-navy/50">{p.sku}</span>}
                  </span>
                  {otherCat && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      in {otherCat}
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            loading={assign.isPending || unassign.isPending}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
