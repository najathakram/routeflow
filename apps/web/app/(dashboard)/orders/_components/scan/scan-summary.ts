import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";

/** The slice of an order line the scan screen needs — structurally satisfied by `LineItemRowItem`. */
export interface SummaryLine {
  productId: string;
  isUnlisted?: boolean;
  unitPrice: number;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number;
}

/**
 * Header count (owner ruling D2): DISTINCT SKUs on the order, never total units — `qty` is already
 * on every row, and a units figure next to a $ total reads as a second, unrelated number. An
 * unlisted (free-text) line has no SKU (`productId` is ""), so each one counts as its own item.
 */
export function distinctSkuCount(lines: readonly SummaryLine[]): number {
  const skus = new Set<string>();
  let unlisted = 0;
  for (const l of lines) {
    if (l.isUnlisted || !l.productId) unlisted++;
    else skus.add(l.productId);
  }
  return skus.size + unlisted;
}

/**
 * The persistent footer total — `computeLineSubtotal` per line exactly as CreateOrderModal sums
 * it (boxed proration; never `qty * unitPrice`), rounded once at the end (`roundMoney`).
 */
export function scanTotal(lines: readonly SummaryLine[]): number {
  return roundMoney(
    lines.reduce(
      (sum, l) =>
        sum +
        computeLineSubtotal({
          unitPrice: l.unitPrice,
          qty: l.qty,
          boxes: l.boxes ?? null,
          pieces: l.pieces ?? null,
          unitsPerBox: l.unitsPerBox ?? null,
        }),
      0,
    ),
  );
}

/** What one accepted scan did to the order — enough to invert it. */
export interface ScanHistoryEntry {
  productId: string;
  /** True when this scan CREATED the line; false when it incremented an existing one. */
  created: boolean;
}

/** Bounded so a long scanning session cannot grow the stack without limit. */
export const SCAN_HISTORY_LIMIT = 100;

export function pushHistory(
  history: readonly ScanHistoryEntry[],
  entry: ScanHistoryEntry,
): ScanHistoryEntry[] {
  const next = [...history, entry];
  return next.length > SCAN_HISTORY_LIMIT ? next.slice(next.length - SCAN_HISTORY_LIMIT) : next;
}

/** The most recent entry and the stack without it; `entry` is null on an empty stack. */
export function popHistory(history: readonly ScanHistoryEntry[]): {
  entry: ScanHistoryEntry | null;
  rest: ScanHistoryEntry[];
} {
  if (history.length === 0) return { entry: null, rest: [] };
  return { entry: history[history.length - 1], rest: history.slice(0, -1) };
}
