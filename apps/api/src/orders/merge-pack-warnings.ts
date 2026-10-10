import type { Logger } from "@nestjs/common";
import type { MergeWarning } from "./merge-line-writes";

/**
 * The merge paths' pack-warning reporting (SA-124), moved verbatim out of the service (`caller` picks the method name
 * each log line carries; `forceConsolidateCustomer` passes no callbacks): a genuine
 * disagreement (packMismatch) and a box-unaware contribution resolved via the live product pack
 * (livePackFallback, SA-101(a) branch 4) are independent conditions with their own message and callback.
 */
const CALLER_METHOD = {
  merge: "mergeAllPendingForCustomer",
  consolidate: "forceConsolidateCustomer",
} as const;

export function reportPackWarnings(
  logger: Pick<Logger, "warn">,
  caller: "merge" | "consolidate",
  winnerId: string,
  packWarnings: readonly MergeWarning[],
  opts?: {
    onPackMismatch?: (warnings: MergeWarning[]) => void;
    onLivePackFallback?: (warnings: MergeWarning[]) => void;
  },
): { mismatch: number; livePack: number } {
  const mismatchWarnings = packWarnings.filter((w) => w.kind === "packMismatch");
  const livePackWarnings = packWarnings.filter((w) => w.kind === "livePackFallback");
  if (mismatchWarnings.length > 0) {
    for (const w of mismatchWarnings) {
      logger.warn(
        `${CALLER_METHOD[caller]}: order ${winnerId} product ${w.productId} contributing lines disagree on pack [${w.packs.join(", ")}] — kept as separate lines, never folded (B776)`,
      );
    }
    opts?.onPackMismatch?.(mismatchWarnings);
  }
  if (livePackWarnings.length > 0) {
    for (const w of livePackWarnings) {
      logger.warn(
        `${CALLER_METHOD[caller]}: order ${winnerId} product ${w.productId} had no pack snapshot on any contributing line — resolved via the live product pack [${w.packs.join(", ")}] (B776)`,
      );
    }
    opts?.onLivePackFallback?.(livePackWarnings);
  }
  return { mismatch: mismatchWarnings.length, livePack: livePackWarnings.length };
}
