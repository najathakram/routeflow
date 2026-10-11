import * as React from "react";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import {
  addLeg,
  newSplitRows,
  patchLeg,
  payOneWay,
  removeLeg,
  splitIssue,
  summarizeSplit,
  type SplitIssue,
  type SplitLegRow,
  type SplitSummary,
} from "@/lib/counter-split-tender";

/**
 * The counter's split-payment state, kept out of CounterSaleScreen. Two halves so the screen can restore a held attempt before
 * the sale total is known: `useSplitRows` owns the open lines (null = the plain single tender) with STABLE actions;
 * `useSplitView` derives the live summary, the inline issue and `blocked` from them. Nothing here talks to the server; the sale
 * is only written when the screen's Complete sends the lines.
 */
export function useSplitRows() {
  const [rows, setRows] = React.useState<SplitLegRow[] | null>(null);
  // Complete was tried while a rule held it back: the inline lines that wait for an attempt show now
  const [attempted, setAttempted] = React.useState(false);
  // true only when the CLERK opened the split (a restored held attempt does not take the cursor)
  const [focusFirst, setFocusFirst] = React.useState(false);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;

  const edit = React.useCallback((next: (r: SplitLegRow[]) => SplitLegRow[]) => {
    setAttempted(false);
    setRows((r) => (r ? next(r) : r));
  }, []);

  /** replaces the lines outright (a held attempt restored, a sale reset); null closes the split */
  const restore = React.useCallback((next: SplitLegRow[] | null) => {
    setAttempted(false);
    setFocusFirst(false);
    setRows(next);
  }, []);

  return React.useMemo(
    () => ({
      rows,
      attempted,
      focusFirst,
      open: () => {
        setAttempted(false);
        setFocusFirst(true);
        setRows(newSplitRows());
      },
      /** closes onto the first line's method; the caller applies it to the single-tender state */
      closeToSingle: (): { method: CounterSalePaymentMethod; reference: string } | null => {
        const current = rowsRef.current;
        if (!current) return null;
        setAttempted(false);
        setFocusFirst(false);
        setRows(null);
        return payOneWay(current);
      },
      restore,
      patch: (id: string, p: Partial<Omit<SplitLegRow, "id">>) => edit((r) => patchLeg(r, id, p)),
      add: (remainingCents: number) => edit((r) => addLeg(r, remainingCents)),
      remove: (id: string) => edit((r) => removeLeg(r, id)),
      markAttempted: () => setAttempted(true),
    }),
    [rows, attempted, focusFirst, edit, restore],
  );
}

export function useSplitView(
  state: ReturnType<typeof useSplitRows>,
  input: { totalCents: number; isWalkIn: boolean },
): {
  summary: SplitSummary | null;
  issue: SplitIssue | null;
  /** Complete is not offered while a rule is broken (a walk-in must also have paid in full) */
  blocked: boolean;
} {
  const { rows, attempted } = state;
  const { totalCents, isWalkIn } = input;
  const summary = React.useMemo(
    () => (rows ? summarizeSplit({ rows, totalCents, isWalkIn }) : null),
    [rows, totalCents, isWalkIn],
  );
  return {
    summary,
    issue: summary ? splitIssue(summary, attempted) : null,
    blocked: summary !== null && summary.problem !== null,
  };
}
