import * as React from "react";
import { cn } from "@routeflow/ui/web";
import {
  BACKORDER_HINT,
  backorderQtyText,
  backorderTagText,
  type BackorderUnit,
} from "@/lib/backorder-tag-text";

/**
 * The staff "Backorder" tag on an order line (SA-714): its own block under the product name, never
 * inside the name's run of text. The pill itself never wraps (`whitespace-nowrap`) and states the
 * shortfall in the line's own unit; what it means ("Ships when stock arrives") is visible text beside
 * it, which wraps as a whole under it on a narrow card rather than clipping the pill.
 */
export function BackorderTag({
  pieces,
  unit,
  className,
}: {
  pieces: number;
  unit?: BackorderUnit | null;
  className?: string;
}) {
  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      <span
        data-testid="line-backorder-tag"
        title={`${backorderQtyText(pieces, unit)} sold past stock`}
        className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200"
      >
        {backorderTagText(pieces, unit)}
      </span>
      <span className="text-xs text-navy/70">{BACKORDER_HINT}</span>
    </div>
  );
}
