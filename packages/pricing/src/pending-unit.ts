/**
 * #2865 case c (SA-632): the ONE definition of a PENDING order line, shared by web and mobile (L-072, no
 * second mirror). A line is pending while its default selling unit has not been resolved: the line was
 * added by a picker tap or scan and is flagged `startOnDefaultUnit`, and the units ladder has not loaded
 * (or failed to). Its unit is decided ONCE, by the resolver, and its quantity must never depend on load
 * timing: every quantity edit on a pending line is REFUSED in the logic (`refusesPendingEdit`), and the
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

/** What the user is trying to do to a line. Only a default-start TAP may add to a PENDING line. */
export type PendingEditIntent = "qty" | "price" | "unit" | "increment" | "tap";

/**
 * #2865 (SA-632): is this edit REFUSED because the line is pending? A pending line's unit is decided ONCE by the
 * resolver, so a quantity, a typed price, a units total or a stepper increment would settle it as the wrong thing
 * (N cases). Refused in the logic (not only by a disabled control). A settled or absent line is never refused.
 */
export function refusesPendingEdit(
  line: PendingUnitFacts | undefined,
  intent: PendingEditIntent,
): boolean {
  if (!line || !isUnitPending(line)) return false;
  return intent !== "tap";
}

export type PendingScanDecision = "add" | "tap" | "refuse";

/**
 * A scan landing on an EXISTING line. While it is pending a scan that maps to the DEFAULT unit counts as one tap; a
 * scan of a DIFFERENT level is refused (not counted, not "added"). A settled or absent line takes the scan as usual.
 */
export function pendingScanDecision(
  line: PendingUnitFacts | undefined,
  scan: { mapsToDefault: boolean },
): PendingScanDecision {
  if (!line || !isUnitPending(line)) return "add";
  return scan.mapsToDefault ? "tap" : "refuse";
}

/** The recorded pending tap count, else the caller's fallback; N taps = N of the default unit, never below 1. */
export function pendingTapCount(taps: number | null | undefined, fallback: number): number {
  if (taps != null && taps >= 1) return taps;
  return Math.max(1, fallback);
}

export type PendingBlockReason = "units-unknown" | "product-missing" | "ladder-failed";

export type PendingResolvePlan =
  | { plan: "settle" }
  | { plan: "fetch" }
  | { plan: "blocked"; reason: "units-unknown" | "product-missing" };

/**
 * What the resolver does with ONE pending line before it touches the ladder. Non-staff (the server rejects a unit
 * line from any other role), unlisted lines and a tenant with units switched off settle on the pack; an unknown units
 * answer or a missing product record is BLOCKED (never settled on the pack); otherwise the ladder is fetched.
 */
export function pendingResolvePlan(f: {
  isStaff: boolean;
  unitsEnabled: boolean;
  unitsKnown: boolean;
  unlisted?: boolean;
  /** false when the line's product record is missing (mobile); omitted when not applicable. */
  productKnown?: boolean;
}): PendingResolvePlan {
  if (f.unlisted || !f.isStaff || (f.unitsKnown && !f.unitsEnabled)) return { plan: "settle" };
  if (!f.unitsKnown) return { plan: "blocked", reason: "units-unknown" };
  if (f.productKnown === false) return { plan: "blocked", reason: "product-missing" };
  return { plan: "fetch" };
}

export type PendingStatus = "loading" | "failed";

/**
 * Loading vs failed for a PENDING line (M1). Nothing failed yet, or the subscription read still in flight
 * (`units-unknown`), is LOADING; a failed subscription read, a failed ladder fetch or a missing product is FAILED.
 */
export function pendingStatus(
  pending: boolean,
  f: { reason?: PendingBlockReason; subscriptionFailed?: boolean },
): PendingStatus | undefined {
  if (!pending) return undefined;
  if (f.reason == null) return "loading";
  if (f.reason === "units-unknown") return f.subscriptionFailed ? "failed" : "loading";
  return "failed";
}

/** An async resolve never overwrites what the user did meanwhile: only a still-pending line at the same tap count. */
export function mayMergeResolved(f: {
  cur: PendingUnitFacts | undefined;
  curCount: number;
  beforeCount: number;
  changed: boolean;
}): boolean {
  return f.changed && !!f.cur && isUnitPending(f.cur) && f.curCount === f.beforeCount;
}

/**
 * "Try again": a STAFF caller whose units answer is still unknown (the subscription read failed or never settled)
 * REFETCHES it instead of staying stuck on the stale failure. A known answer, a non-staff caller, or a refetch that
 * fails again leave the deps as they were, so the line stays blocked, never the pack.
 */
export async function refreshUnitsAnswer<
  D extends { isStaff: boolean; unitsKnown: boolean; unitsEnabled: boolean },
>(
  deps: D,
  refetch: () => Promise<{ isSuccess: boolean; flags: readonly string[] }>,
  unitsFlag: string,
): Promise<D> {
  if (!deps.isStaff || deps.unitsKnown) return deps;
  try {
    const r = await refetch();
    return r.isSuccess
      ? { ...deps, unitsKnown: true, unitsEnabled: r.flags.includes(unitsFlag) }
      : deps;
  } catch {
    return deps;
  }
}

/**
 * Undo of one scan on a PENDING line takes one TAP back (it never steps a quantity or settles a unit). Undoing the
 * creating scan (one tap left) REMOVES the line.
 */
export function undoPendingTap(
  taps: number | null | undefined,
): { remove: true } | { remove: false; taps: number } {
  const n = pendingTapCount(taps, 1);
  return n <= 1 ? { remove: true } : { remove: false, taps: n - 1 };
}

/**
 * The key the resolver effect re-runs on: each pending line's id AND its tap count. Keyed on the count (not a quantity,
 * which a tap no longer moves) so a tap that lands DURING the ladder fetch makes the stale merge skip AND the resolver
 * run again, instead of leaving the line on "loading" forever.
 */
export function pendingResolveKey(entries: ReadonlyArray<{ id: string; count: number }>): string {
  return entries.map((e) => `${e.id}:${e.count}`).join("|");
}

/**
 * #2865 (N3): the quantity a PENDING line settles to when its default unit IS the pack (no flagged non-pack default, units
 * switched off, or a role that never sells by a unit). N taps = N PACKS, never one: a case-packed line (units per box > 1)
 * is N whole cases (boxes N, qty N x units per box), a plain line is qty N. EVERY settle path uses this, so the count the
 * user tapped is never dropped by a clear-the-flag-only settle.
 */
export function packQtyForTaps(
  taps: number | null | undefined,
  unitsPerBox?: number | null,
): { qty: number; boxes?: number; pieces?: number } {
  const n = pendingTapCount(taps, 1);
  const upb = Number(unitsPerBox ?? 0);
  return upb > 1 ? { boxes: n, pieces: 0, qty: n * upb } : { qty: n };
}
