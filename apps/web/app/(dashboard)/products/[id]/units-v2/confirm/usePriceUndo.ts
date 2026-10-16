import * as React from "react";
import { isLadderRevisionStale } from "./StaleRevisionNotice";
import type { UndoFn, UndoOutcome, UndoPreviewRow } from "./types";

export interface PriceUndoDeps {
  /** K3's `lastSave` (the audit row to invert and the revision the save produced). */
  lastSave: { auditId: string; revision: number } | null;
  /** The grid the page holds now (K3's `usePriceGrid` / draft grid): its revision and `priceState`. */
  current: { revision: number; priceState?: string } | null | undefined;
  /** K3's `useUndoPrices(productId).mutateAsync` (POST /prices/undo). */
  mutate: (req: {
    auditId: string;
    expectedRevision: number;
    expectedPriceState?: string;
  }) => Promise<unknown>;
  /** Refetch the grid and build the rows the inverse would make on it (K3's `undoPreview`). */
  loadPreview: () => Promise<{ revision: number; priceState?: string; rows: UndoPreviewRow[] }>;
}

const codeOf = (e: unknown) =>
  (e as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;

/**
 * The `undo` the status line takes (UX-V5 section 5 item 2): ONE inverse write, previewed first when
 * anything changed since the save. A confirmed call re-sends the PREVIEW's revision and price state, so
 * it can never overwrite a newer change; a stale answer to it just re-previews.
 */
export function usePriceUndo(deps: PriceUndoDeps): UndoFn {
  const ref = React.useRef(deps);
  ref.current = deps;
  return React.useCallback(async (req): Promise<UndoOutcome> => {
    const { lastSave, current, mutate, loadPreview } = ref.current;
    if (!lastSave) throw new Error("Nothing to undo");
    const changed = async (): Promise<UndoOutcome> => ({
      status: "changed",
      ...(await loadPreview()),
    });
    const revision = req.confirmed ? req.expectedRevision : current?.revision;
    if (revision === undefined) return changed();
    // Unconfirmed and the grid already moved past the save: preview, write nothing.
    if (!req.confirmed && revision !== lastSave.revision) return changed();
    try {
      await mutate({
        auditId: lastSave.auditId,
        expectedRevision: revision,
        expectedPriceState: req.confirmed ? req.expectedPriceState : current?.priceState,
      });
      return { status: "undone" };
    } catch (e) {
      if (isLadderRevisionStale(e)) return changed();
      if (codeOf(e) === "PRICE_UNDO_UNAVAILABLE") return { status: "unavailable" };
      throw e;
    }
  }, []);
}
