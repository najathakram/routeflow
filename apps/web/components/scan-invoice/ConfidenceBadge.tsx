"use client";

import { cn } from "@routeflow/ui/web";
import type { ScannedItem } from "@/lib/api/invoice-scan";

export function ConfidenceBadge({
  confidence,
  matchSource,
}: {
  confidence: ScannedItem["confidence"];
  /** Present when the match came from a taught correction — outranks the
   *  fuzzy-confidence label below, since it isn't a guess. */
  matchSource?: ScannedItem["matchSource"] | null;
}) {
  if (matchSource === "alias" || matchSource === "memory") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700"
        title="Remembered from a previous correction on this supplier. Clearing this match makes the scanner forget it — the next scan will guess again."
      >
        Remembered match
      </span>
    );
  }
  const styles: Record<ScannedItem["confidence"], string> = {
    high: "bg-green-100 text-green-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-orange-100 text-orange-700",
    none: "bg-gray-100 text-gray-600",
  };
  // "low" no longer means "matched, but shakily" — the matcher never
  // auto-assigns below 0.6, so a "low" line arrives UNLINKED with ranked
  // "Did you mean…" chips below it instead. Label + tooltip say so.
  const labels: Record<ScannedItem["confidence"], string> = {
    high: "High match",
    medium: "Possible match",
    low: "Unmatched",
    none: "No match",
  };
  const titles: Partial<Record<ScannedItem["confidence"], string>> = {
    low: "No confident match — review the suggestions below",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        styles[confidence],
      )}
      title={titles[confidence]}
    >
      {labels[confidence]}
    </span>
  );
}
