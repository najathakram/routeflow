"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { OFF_PAGE_HINT, OFF_PAGE_HINT_ID } from "@/lib/rule-chooser";

/**
 * Row 509 PR5: "Select all matching" puts ids BEYOND the visible page in the selection, and only Restrict… may act on
 * those. This is the one rule: a selection is OFF-PAGE when it holds any id the page does not show. It reads the ids
 * (not the banner's own state), so un-ticking one visible row cannot turn the other actions back on for ids the
 * operator cannot see.
 */
export function useOffPageSelection(
  selected: ReadonlySet<string>,
  pageHas: (id: string) => boolean,
): { offPage: boolean; hint: string | undefined } {
  let offPage = false;
  selected.forEach((id) => {
    if (!pageHas(id)) offPage = true;
  });
  return { offPage, hint: offPage ? OFF_PAGE_HINT : undefined };
}

/** The bulk bar's destructive "Delete N items": off while the selection is off-page (and it says why). */
export function BulkDeleteButton({
  count,
  offPage,
  hint,
  loading,
  onClick,
}: {
  count: number;
  offPage: boolean;
  hint: string | undefined;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="danger"
      leftIcon={<Trash2 className="h-4 w-4" />}
      loading={loading}
      disabled={offPage}
      title={hint}
      aria-describedby={offPage ? OFF_PAGE_HINT_ID : undefined}
      onClick={onClick}
    >
      Delete {count} item{count !== 1 ? "s" : ""}
    </Button>
  );
}
