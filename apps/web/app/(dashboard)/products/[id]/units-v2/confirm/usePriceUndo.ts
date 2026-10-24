import * as React from "react";
import { priceWriteError } from "@/lib/api/usePriceWrites";
import { isLadderRevisionStale } from "./StaleRevisionNotice";
import type { CustomerPriceConflict, SavePricesResponse, UndoSkipCell } from "@routeflow/types";
import type { UndoConflict, UndoFn, UndoOutcome, UndoPreviewRow } from "./types";

export interface PriceUndoDeps {
  /** K3's `lastSave` (the audit row to invert and the revision the save produced). */
  lastSave: { auditId: string; revision: number } | null;
  /** The grid the page holds now (K3's `usePriceGrid` / draft grid): its revision and `priceState`. */
  current: { revision: number; priceState: string } | null | undefined;
  /** K3's `useUndoPrices(productId).mutateAsync` (POST /prices/undo). */
  mutate: (req: {
    auditId: string;
    expectedRevision: number;
    expectedPriceState: string;
    skip?: UndoSkipCell[];
  }) => Promise<Pick<SavePricesResponse, "skipped"> | unknown>;
  /** ONE place where a 409 conflict becomes a preview row (customer name, tier-first unit label, formatted money). */
  conflictRow: (c: CustomerPriceConflict) => UndoPreviewRow;
  /** Refetch the grid and build the rows the inverse would make on it (K3's `loadUndoPreview`). */
  loadPreview: () => Promise<{
    revision: number;
    priceState: string;
    rows: UndoPreviewRow[];
    customerMoves?: number;
  }>;
}

/**
 * The `undo` the status line takes (UX-V5 section 5 item 2): ONE inverse write, previewed first when
 * anything changed since the save. A confirmed call re-sends the PREVIEW's revision and price state, so
 * it can never overwrite a newer change; a stale answer to it just re-previews.
 */
export function usePriceUndo(deps: PriceUndoDeps): UndoFn {
  const ref = React.useRef(deps);
  ref.current = deps;
  return React.useCallback(async (req): Promise<UndoOutcome> => {
    const { lastSave, current, mutate, loadPreview, conflictRow } = ref.current;
    if (!lastSave) throw new Error("Nothing to undo");
    const changed = async (conflicts: UndoConflict[] = []): Promise<UndoOutcome> => ({
      status: "changed",
      ...(await loadPreview()),
      ...(conflicts.length > 0 ? { conflicts } : {}),
    });
    const revision = req.confirmed ? req.expectedRevision : current?.revision;
    if (revision === undefined) return changed();
    // Unconfirmed and the grid already moved past the save: preview, write nothing.
    if (!req.confirmed && revision !== lastSave.revision) return changed();
    // expectedPriceState is required: without one there is no valid precondition, so no request is made.
    const priceState = req.confirmed ? req.expectedPriceState : current?.priceState;
    if (!priceState) throw new Error("Prices are not ready to undo");
    try {
      const res = await mutate({
        auditId: lastSave.auditId,
        expectedRevision: revision,
        expectedPriceState: priceState,
        ...(req.confirmed && req.skip && req.skip.length > 0 ? { skip: req.skip } : {}),
      });
      const skipped = (res as Pick<SavePricesResponse, "skipped"> | undefined)?.skipped?.length;
      return skipped ? { status: "undone", skipped } : { status: "undone" };
    } catch (e) {
      if (isLadderRevisionStale(e)) {
        const raw = (e as { response?: { data?: { conflicts?: CustomerPriceConflict[] } } })
          .response?.data?.conflicts;
        return changed(
          (raw ?? []).map((c) => ({
            row: conflictRow(c),
            skip: { customerId: c.customerId, ref: c.ref, seen: c.current },
          })),
        );
      }
      if (priceWriteError(e)?.code === "unavailable") return { status: "unavailable" };
      throw e;
    }
  }, []);
}
