/**
 * #2865 case c (SA-632): the ONE definition of a PENDING order line, shared by web and mobile (L-072, no
 * second mirror). A line is pending while its default selling unit has not been resolved: the line was
 * added by a picker tap or scan and is flagged `startOnDefaultUnit`, and the units ladder has not loaded
 * (or failed to). Its unit is decided ONCE, by the resolver, and its quantity must never depend on load
 * timing: every quantity edit on a pending line is REFUSED in the logic (`refusePendingQtyEdit`), and the
 * controls are disabled as well.
 */
export interface PendingUnitFacts {
  /** web: a boolean; mobile: the qty the line held when it was flagged (holds only while qty is unchanged). */
  startOnDefaultUnit?: number | boolean | null;
  qty?: number | null;
  /** The line already has a shape the default must not override (web: a unit, boxes/pieces, a typed price). */
  shaped?: boolean;
  /** An operator-typed price (mobile): a shaped line. */
  operatorPrice?: boolean;
}

export function isUnitPending(facts: PendingUnitFacts): boolean {
  const flag = facts.startOnDefaultUnit;
  if (flag == null || flag === false) return false;
  if (typeof flag === "number" && flag !== facts.qty) return false;
  return !facts.shaped && !facts.operatorPrice;
}

/** Applies a quantity edit unless the line is pending; a pending line comes back UNCHANGED (same reference). */
export function refusePendingQtyEdit<T extends PendingUnitFacts>(line: T, edit: (line: T) => T): T {
  return isUnitPending(line) ? line : edit(line);
}
