/**
 * SA-1508 A3-H2: the BUY_N_GET_M free units a line can carry after an edit, in ONE place. Both edit screens
 * (web `lineFreeUnits`, mobile `editedLineFreeUnits`) and the API's "untouched line" test take this number, so a
 * screen and the server agree on what a save writes: a line the screen can express is untouched when its sent free
 * units equal this value, never when they equal a raw stored value a screen cannot reach.
 *
 * The snapshot was earned at `promoBaseUnits` whole selling units (default: the line's own units), so a shrunk line
 * earns proportionally fewer and a grown one never earns MORE than was agreed. Capped at units - 1: the buyer always
 * pays the N in every (N + M), so no line is entirely free. Loose pieces never count: a boxed line's units are its
 * BOXES (`boxes ?? qty`). A stored row above the cap (a partial allocation, a duplicate) reads lower here.
 */
export function editableFreeUnits(line: {
  promoFreeUnits?: number | null;
  /** Whole selling units the snapshot was earned at (defaults to the line's own). */
  promoBaseUnits?: number | null;
  boxes?: number | null;
  qty: number;
}): number {
  const stored = Math.max(0, Math.trunc(Number(line.promoFreeUnits ?? 0) || 0));
  if (stored <= 0) return 0;
  const units = Math.trunc(Number(line.boxes != null ? line.boxes : line.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(Number(line.promoBaseUnits ?? units) || 0));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}
