import type { PendingEditIntent, SellLevel } from "@routeflow/pricing";
import type { LineState } from "./cart-line-state";
import {
  isPendingDefaultUnit,
  isPendingTap,
  keepsDefaultStart,
  pendingTapCount,
  refusesLineEdit,
  scanDecisionFor,
  scanMapsToDefault,
  UNITS_LOADING_SCAN_MESSAGE,
} from "./default-unit-line";
import { addScannedLevelToLine } from "./sale-line";
import type { ScanOutcome } from "./scan-loop";
import { showToast } from "./toast";

/**
 * #2865 (SA-632): the order screen's pending-unit logic, kept OUT of NewOrderScreen.tsx (size ratchet) so the screen holds only
 * call sites. Pure where it can be (the add decision, the Confirm settle), one tiny effect where it must be (the refusal
 * message). Behaviour is the screen's, moved verbatim.
 */
export type Items = Record<string, LineState>;

export interface AddToItemsInput {
  id: string;
  level: SellLevel;
  /** A default-start add (a shared-code scan, the row's first add): see keepsDefaultStart. */
  dflt?: boolean;
  /** The catalog row's "+" (refused while pending), as opposed to a scan. */
  viaRow?: boolean;
  /** The scanned/typed code: a repeat of the code that CREATED a pending line is a tap (scanMapsToDefault). */
  code?: string;
  role?: string | null;
  upb: number;
  /** The remembered price to pre-fill a NEW line with (history), if any. */
  prefill?: number;
}

/**
 * The ONE add decision over the order's lines. While a line is PENDING the row "+" and a scan of a DIFFERENT code/level are
 * REFUSED (the SAME `items` object comes back, so the caller reports it exactly: no "Added", no count); a default-unit scan
 * (or a repeat of the creating code) only counts one more TAP, the line's own quantity never moves. Otherwise the plain add.
 */
export function applyAddToItems(items: Items, a: AddToItemsInput): Items {
  const cur = items[a.id];
  const refused = a.viaRow
    ? refusesLineEdit(cur, "increment")
    : scanDecisionFor(cur, scanMapsToDefault(cur, a.dflt, a.code)) === "refuse";
  if (refused) return items;
  if (cur && isPendingTap(cur, a.dflt, a.code, a.role)) {
    return { ...items, [a.id]: { ...cur, pendingTaps: pendingTapCount(cur, a.upb) + 1 } };
  }
  const isNew = !cur;
  const line = addScannedLevelToLine(cur ?? { qty: 0 }, a.level, a.upb > 1, a.upb);
  if (keepsDefaultStart(cur, a.dflt, a.role)) {
    line.startOnDefaultUnit = line.qty;
    line.pendingTaps = 1; // the first tap; later taps only count (above)
    line.pendingCode = a.code; // a repeat scan of THIS label is a tap, however a later lookup flags it
  }
  if (isNew && a.prefill != null) {
    line.unitPrice = a.prefill;
    // B755: a HISTORY pre-fill, not an operator override (a resume under a different customer re-prices it)
    line.priceSource = "history";
  }
  return { ...items, [a.id]: line };
}

/**
 * A refused scan: EXACTLY ONE message, in the layer the operator can see. With the scan sheet open its own error pill (the app
 * toast renders UNDER the sheet's Modal); otherwise the app toast and no pill (a pill beside it was the stacked second copy).
 */
export function refusedScanOutcome(sheetOpen: boolean): ScanOutcome {
  if (sheetOpen) return { feedback: { kind: "error", text: UNITS_LOADING_SCAN_MESSAGE } };
  showToast(UNITS_LOADING_SCAN_MESSAGE);
  return undefined;
}

export const UNITS_BLOCKED_MESSAGE =
  "Couldn't load the selling units. Check your connection and try again.";

/**
 * Confirm's pending-unit gate: `blocked` (the ladder could not load: toast, no submit), `stop` (this press had to RESOLVE a
 * pending line, the retry after a failed load: show the settled line, a second press submits), or `ready` (submit `lines`).
 */
export async function settleBeforeConfirm(
  items: Items,
  resolve: (items: Items) => Promise<{ items: Items; blocked: string[] }>,
): Promise<{ kind: "blocked" } | { kind: "stop" | "ready"; lines: Items }> {
  const { items: lines, blocked } = await resolve(items);
  if (blocked.length) return { kind: "blocked" };
  return { kind: Object.values(items).some(isPendingDefaultUnit) ? "stop" : "ready", lines };
}

/** True while any pending line's units are still LOADING (a failed load is not loading: its Confirm press is the retry). */
export function anyLineLoading(
  items: Items,
  statusFor: (id: string, line: LineState | undefined) => "loading" | "failed" | undefined,
): boolean {
  return Object.entries(items).some(([id, l]) => statusFor(id, l) === "loading");
}

/**
 * One quantity edit on one line (the order screen's setBoxes / setPieces / setUnits / setQty / removeOne): REFUSED on a pending
 * line (the same `items` back), otherwise `edit` over the line (or a blank one); a null result removes the line.
 */
export function editItemLine(
  items: Items,
  id: string,
  intent: PendingEditIntent,
  edit: (prev: LineState) => LineState | null,
): Items {
  if (refusesLineEdit(items[id], intent)) return items;
  const line = edit(items[id] ?? { qty: 0 });
  if (!line) {
    const next = { ...items };
    delete next[id];
    return next;
  }
  return { ...items, [id]: line };
}
