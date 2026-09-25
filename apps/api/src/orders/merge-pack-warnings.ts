import type { Logger } from "@nestjs/common";
import type { MergeWarning } from "./merge-line-writes";

/**
 * `mergeAllPendingForCustomer`'s pack-warning reporting (SA-124), moved verbatim out of the service: a genuine
 * disagreement (packMismatch) and a box-unaware contribution resolved via the live product pack
 * (livePackFallback, SA-101(a) branch 4) are independent conditions with their own message and callback.
 */
export function reportMergePackWarnings(
  logger: Pick<Logger, "warn">,
  winnerId: string,
  packWarnings: readonly MergeWarning[],
  opts?: {
    onPackMismatch?: (warnings: MergeWarning[]) => void;
    onLivePackFallback?: (warnings: MergeWarning[]) => void;
  },
): void {
  const mismatchWarnings = packWarnings.filter((w) => w.kind === "packMismatch");
  const livePackWarnings = packWarnings.filter((w) => w.kind === "livePackFallback");
  if (mismatchWarnings.length > 0) {
    for (const w of mismatchWarnings) {
      logger.warn(
        `mergeAllPendingForCustomer: order ${winnerId} product ${w.productId} contributing lines disagree on pack [${w.packs.join(", ")}] — kept as separate lines, never folded (B776)`,
      );
    }
    opts?.onPackMismatch?.(mismatchWarnings);
  }
  if (livePackWarnings.length > 0) {
    for (const w of livePackWarnings) {
      logger.warn(
        `mergeAllPendingForCustomer: order ${winnerId} product ${w.productId} had no pack snapshot on any contributing line — resolved via the live product pack [${w.packs.join(", ")}] (B776)`,
      );
    }
    opts?.onLivePackFallback?.(livePackWarnings);
  }
}
