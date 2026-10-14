"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { useProductIdsForFilter, type ProductIdsFilters } from "@/lib/api/rule-targets";
import { RESTRICT_MAX } from "@/lib/rule-chooser";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * "Select all N matching" (row 509 PR5, owner Q5): the Gmail / Apple Mail banner under the catalog toolbar. It shows
 * when the page checkbox selected EVERY row on the page and more rows match than the page holds; one click fetches the
 * ids behind the CURRENT filters (capped at 1,000, and it says so). It lives only as long as the selection it made:
 * `resetKey` (the page's REG-B154 inputs) clears it, and so does any change to the selection's size.
 */
export function SelectAllMatching({
  filters,
  resetKey,
  selected,
  setSelected,
  pageIds,
  total,
}: {
  filters: ProductIdsFilters;
  /** Changes whenever the page, a filter or the page size changes - the same inputs as the selection reset. */
  resetKey: string;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  /** The ids on the visible page. */
  pageIds: string[];
  /** Every row that matches the current filters. */
  total: number;
}) {
  const fetchIds = useProductIdsForFilter(filters);
  const [matched, setMatched] = React.useState<{
    count: number;
    total: number;
    capped: boolean;
  } | null>(null);
  // A result for filters the operator has since left must be dropped, not applied.
  const keyRef = React.useRef(resetKey);
  keyRef.current = resetKey;

  React.useEffect(() => setMatched(null), [resetKey]);

  const active = matched !== null && selected.size === matched.count;
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const capped = total > RESTRICT_MAX;

  if (active && matched) {
    return (
      <div
        role="status"
        data-testid="select-all-matching"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-navy"
      >
        <span>
          {matched.capped
            ? `The first ${fmt(matched.count)} of ${fmt(matched.total)} matching are selected.`
            : `All ${fmt(matched.count)} matching are selected.`}
        </span>
        {matched.capped && (
          <span className="text-navy/70">Narrow the filters to reach the rest.</span>
        )}
        <button
          type="button"
          className="min-h-11 font-medium text-brand-600 hover:underline sm:min-h-0"
          onClick={() => setSelected(new Set())}
        >
          Clear selection
        </button>
      </div>
    );
  }

  if (!pageAllSelected || total <= pageIds.length) return null;

  const run = () => {
    const sentFor = resetKey;
    fetchIds.mutate(undefined, {
      onSuccess: (res) => {
        if (keyRef.current !== sentFor) return;
        const next = new Set(res.ids);
        setSelected(next);
        setMatched({ count: next.size, total: res.total, capped: res.capped });
      },
    });
  };

  return (
    <div
      role="status"
      data-testid="select-all-matching"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-navy"
    >
      <span>All {pageIds.length} on this page are selected.</span>
      <Button
        type="button"
        variant="link"
        loading={fetchIds.isPending}
        className="min-h-11 sm:min-h-0"
        onClick={run}
      >
        {capped
          ? `Select the first ${fmt(RESTRICT_MAX)} of ${fmt(total)} matching`
          : `Select all ${fmt(total)} matching`}
      </Button>
      {capped && (
        <span className="text-navy/70">
          You can act on up to {fmt(RESTRICT_MAX)} products at once. Narrow the filters to reach the
          rest.
        </span>
      )}
    </div>
  );
}
