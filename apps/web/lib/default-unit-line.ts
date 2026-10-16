import type { ProductUnitLevel } from "@routeflow/types";
import {
  isUnitPending,
  mayMergeResolved,
  normalizeBoxesPieces,
  pendingResolvePlan,
  pendingTapCount,
  refreshUnitsAnswer as refreshUnitsAnswerShared,
  type DerivedBaseMarker,
  type PendingBlockReason,
} from "@routeflow/pricing";
import {
  applyLineUnit,
  ladderProductOf,
  mergeSameLine,
  sameProductUnit,
  type UnitLine,
} from "@/lib/order-line-unit";
import { newLineQty } from "@/app/(dashboard)/orders/_components/add-line-merge";
import { buildUnitOptions, defaultUnitValue, type UnitOption } from "@/lib/unit-options";

/**
 * SA-626c (tier 1 money): the default selling unit belongs to the LINE, never to a mounted row. A line flagged
 * `startOnDefaultUnit` (picker tap, shared-code scan, multi-match pick) is moved onto the product's default unit by
 * THIS module once the ladder is known, so the order the operator submits carries a stored unit. The row's
 * OrderLineUnitPicker resolves through the same predicate and writer, so there is one rule and no second copy.
 */

/** #2865 (SA-632 H2): the visible refusal of a scan of a DIFFERENT level while a line's default unit is loading. */
export const UNITS_LOADING_SCAN_MESSAGE = "Units are still loading. Scan again in a moment";

type Tier = number;

/** The line fields the rule reads (structurally satisfied by the modal's LineItem). */
export interface DefaultUnitLine extends UnitLine {
  tempId: string;
  productId: string;
  isUnlisted?: boolean;
  startOnDefaultUnit?: boolean;
  /** #2865 case c: how many default-start taps this PENDING line has recorded (N taps = N of the default unit). */
  pendingTaps?: number;
  priceEdited?: boolean;
}

/**
 * The operator has shaped this line (a unit, a typed price): never start it on the default. A price the SYSTEM pre-filled
 * from the customer's history (DISCOUNTED/MANUAL + discountedPrice at add time) is NOT a shape: a remembered price never
 * decides the unit (owner ruling SA-626d). Every operator price handler consumes the flag, so a still-set flag means untouched.
 */
export function isShapedLine(
  line: { unitLabel?: string; priceEdited?: boolean } & DerivedBaseMarker,
): boolean {
  return !!line.unitLabel || !!line.derivedBase || !!line.priceEdited;
}

/** Does this add keep (or start) the default-start flag? A default-start add to a still-pending line only. */
export function keepsDefaultStart(prev: DefaultUnitLine, dflt?: boolean): boolean {
  return !!dflt && isPendingDefaultUnit(prev);
}

/** Fast adds before the ladder loaded: N adds = N of the default unit (a boxed line's qty is total pieces). */
export function pendingCount(line: UnitLine & { pendingTaps?: number }): number {
  // #2865 case c: the PENDING TAP COUNT is recorded explicitly (never inferred from a quantity in a guessed unit).
  return pendingTapCount(
    line.pendingTaps,
    line.unitsPerBox ? (line.boxes ?? Math.round(line.qty / line.unitsPerBox)) : line.qty,
  );
}

/** Still waiting for its default unit. Qty is not a guard (on a boxed line it is total pieces). */
export function isPendingDefaultUnit(line: DefaultUnitLine): boolean {
  // #2865 case c (SA-632): the shared definition (one predicate for web and mobile, @routeflow/pricing).
  return isUnitPending({ startOnDefaultUnit: line.startOnDefaultUnit, shaped: isShapedLine(line) });
}

/**
 * The ONE writer of a chosen unit on an order's lines (the picker's onChange and the default start): switches the line,
 * CONSUMES the default-start flag, and folds into a twin line of the same product + unit.
 */
/** One line folded into a twin of the same product + unit while resolving (the resolved line, before it disappeared). */
export interface UnitFold<T> {
  from: string;
  into: string;
  add: T;
}

export function applyUnitToLines<T extends DefaultUnitLine>(
  prev: T[],
  tempId: string,
  option: UnitOption,
  refresh: boolean,
  tier: Tier,
): T[] {
  return applyUnitToLinesDetailed(prev, tempId, option, refresh, tier).lines;
}

export function applyUnitToLinesDetailed<T extends DefaultUnitLine>(
  prev: T[],
  tempId: string,
  option: UnitOption,
  refresh: boolean,
  tier: Tier,
): { lines: T[]; fold?: UnitFold<T> } {
  const target = prev.find((li) => li.tempId === tempId);
  if (!target) return { lines: prev };
  // startOnDefaultUnit is CONSUMED by any unit choice (incl. the pack): a remount can never re-apply the default over
  // the operator's choice (Opus #2865 B1).
  // Re-applying the unit the line ALREADY holds (a stale picker after the resolver ran) keeps its quantity (N2).
  const sameUnit = option.kind !== "pack" && target.unitLabel === option.value;
  const next = {
    ...applyLineUnit(target, option, { tier, keepQty: refresh || sameUnit }),
    startOnDefaultUnit: false,
    pendingTaps: undefined,
    // A still-pending line keeps its count (N fast adds = N of the unit); any other choice resets to 1, as always.
    ...(option.kind !== "pack" && isPendingDefaultUnit(target)
      ? { qty: pendingCount(target) }
      : {}),
  };
  // A DERIVED base unit is a pack-pieces line: the pricing package reads boxes/pieces, not qty, so N pending taps
  // must land as N pieces (rolled into boxes), or they fold/bill as 1 (row 536, the P0b repeat-tap case).
  if (option.derived && next.unitsPerBox && isPendingDefaultUnit(target)) {
    const n = normalizeBoxesPieces({
      boxes: 0,
      pieces: pendingCount(target),
      unitsPerBox: next.unitsPerBox,
    });
    Object.assign(next, { boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty });
  }
  const twin = prev.find((li) => li.tempId !== tempId && sameProductUnit(li, next));
  if (!twin) return { lines: prev.map((li) => (li.tempId === tempId ? next : li)) };
  return {
    lines: prev
      .filter((li) => li.tempId !== tempId)
      .map((li) => (li.tempId === twin.tempId ? mergeSameLine(li, next) : li)),
    fold: { from: tempId, into: twin.tempId, add: next },
  };
}

/**
 * #2865 (N3): a pending line whose default unit IS the pack (nothing flagged, units off, a role that never sells by a
 * unit) settles on the PACK with the TAP COUNT it recorded: N taps = N packs, never one. The shared pricing rule decides
 * the quantity; the flag and the count are consumed.
 */
function settleOnPack<T extends DefaultUnitLine>(li: T): T {
  return {
    ...li,
    // web treats ANY non-zero units-per-box as boxed (even 1), so a settled N-pack line is exactly the manual one
    ...newLineQty(li.unitsPerBox, pendingCount(li)),
    startOnDefaultUnit: false,
    pendingTaps: undefined,
  };
}

/** The default-unit option for this line's ladder, or undefined (stay on the pack). */
function defaultOptionFor(
  line: DefaultUnitLine,
  units: readonly ProductUnitLevel[],
  tier: Tier,
): UnitOption | undefined {
  const product = ladderProductOf(line);
  const value = defaultUnitValue(product, units, tier);
  if (!value) return undefined;
  // Scaled from the TIER pack price, never from a remembered/typed unitPrice (SA-626d): no packPrice argument.
  return buildUnitOptions(product, units, tier).find((o) => o.value === value);
}

/** The line once its ladder is known: on the flagged default unit, or (nothing flagged/offered) left on the pack. */
export function startLineOnDefault<T extends DefaultUnitLine>(
  line: T,
  units: readonly ProductUnitLevel[],
  tier: Tier,
): T {
  if (!isPendingDefaultUnit(line)) return line;
  const option = defaultOptionFor(line, units, tier);
  const [only] = option ? applyUnitToLines([line], line.tempId, option, false, tier) : [];
  return (only as T | undefined) ?? settleOnPack(line);
}

/** Only STAFF may sell by a unit (the server's assertMayUseUnits): mirrors the mobile copy (SA-626f). */
export function isStaffRole(role?: string | null): boolean {
  return role === "OPERATOR" || role === "TENANT_ADMIN";
}

export interface DefaultUnitDeps {
  /** Non-staff never start on a default unit and make NO read (N9). */
  isStaff: boolean;
  /** `flag.units_v1`: with it off there is no ladder, so the pack is the only unit. */
  unitsEnabled: boolean;
  /** False while the subscription answer is still loading: "off" is not yet known, so nothing may be resolved. */
  unitsKnown: boolean;
  getUnits: (productId: string) => Promise<ProductUnitLevel[]>;
  tierFor: (productId: string) => Tier;
}

/** "Try again" on the blocked message: the shared rule (@routeflow/pricing), kept under its old name for callers. */
export const refreshUnitsAnswer: (
  deps: DefaultUnitDeps,
  refetch: () => Promise<{ isSuccess: boolean; flags: readonly string[] }>,
  unitsFlag: string,
) => Promise<DefaultUnitDeps> = refreshUnitsAnswerShared;

/**
 * Resolves every pending line, fetching the ladder when it is not cached. A line whose ladder cannot be loaded is
 * reported in `blocked` (by tempId) and left untouched: the caller refuses to submit rather than send the pack by default.
 */
export async function resolvePendingDefaultUnits<T extends DefaultUnitLine>(
  lines: T[],
  deps: DefaultUnitDeps,
): Promise<{
  lines: T[];
  blocked: string[];
  reasons: Record<string, PendingBlockReason>;
  folds: UnitFold<T>[];
}> {
  let out = lines;
  const folds: UnitFold<T>[] = [];
  const blocked: string[] = [];
  const reasons: Record<string, PendingBlockReason> = {};
  const block = (id: string, reason: PendingBlockReason) => {
    blocked.push(id);
    reasons[id] = reason;
  };
  for (const line of lines) {
    if (!isPendingDefaultUnit(line)) continue;
    // #2865 (SA-632 M4): the per-line plan is the shared rule (@routeflow/pricing).
    const plan = pendingResolvePlan({ ...deps, unlisted: line.isUnlisted });
    if (plan.plan === "settle") {
      out = out.map((li) => (li.tempId === line.tempId ? settleOnPack(li) : li));
      continue;
    }
    if (plan.plan === "blocked") {
      block(line.tempId, plan.reason);
      continue;
    }
    try {
      const units = await deps.getUnits(line.productId);
      const tier = deps.tierFor(line.productId);
      const option = defaultOptionFor(line, units, tier);
      if (option) {
        const applied = applyUnitToLinesDetailed(out, line.tempId, option, false, tier);
        out = applied.lines;
        if (applied.fold) folds.push(applied.fold);
      } else {
        out = out.map((li) => (li.tempId === line.tempId ? settleOnPack(li) : li));
      }
    } catch {
      block(line.tempId, "ladder-failed");
    }
  }
  return { lines: out, blocked, reasons, folds };
}

const UNIT_FIELDS = [
  "pendingTaps",
  "unitLabel",
  "derivedBase",
  "unit",
  "unitsPerBox",
  "boxes",
  "pieces",
  "sellBy",
  "qty",
  "listPrice",
  "unitPrice",
  "priceType",
  "specialPrice",
  "discountedPrice",
  "unitCost",
  "packBase",
  "startOnDefaultUnit",
] as const;
function pickUnitFields<T extends DefaultUnitLine>(line: T): Partial<T> {
  return Object.fromEntries(
    UNIT_FIELDS.map((k) => [k, (line as Record<string, unknown>)[k]]),
  ) as Partial<T>;
}

/** An async resolve never overwrites what the operator did meanwhile: apply it only to a line still pending. */
export function mergeResolvedLines<T extends DefaultUnitLine>(
  cur: T[],
  before: T[],
  done: T[],
  folds: ReadonlyArray<UnitFold<T>> = [],
): T[] {
  let out = cur;
  // A pending line that FOLDED into a twin while resolving is gone from `done`: take it out of the current lines and add
  // its resolved count to the twin, or it would sit on "loading" forever (and keep Create Order disabled).
  for (const f of folds) {
    const b = before.find((li) => li.tempId === f.from);
    const c = out.find((li) => li.tempId === f.from);
    const into = out.find((li) => li.tempId === f.into);
    if (
      !b ||
      !into ||
      !mayMergeResolved({
        cur: c && { startOnDefaultUnit: c.startOnDefaultUnit, shaped: isShapedLine(c) },
        curCount: c ? pendingCount(c) : 0,
        beforeCount: pendingCount(b),
        changed: true,
      })
    )
      continue;
    out = out
      .filter((li) => li.tempId !== f.from)
      .map((li) => (li.tempId === f.into ? mergeSameLine(li, f.add) : li));
  }
  for (const d of done) {
    const b = before.find((li) => li.tempId === d.tempId);
    const c = out.find((li) => li.tempId === d.tempId);
    // still pending AND the same count: a 2nd fast add that landed while this resolved must not be overwritten
    if (
      !b ||
      !mayMergeResolved({
        cur: c && { startOnDefaultUnit: c.startOnDefaultUnit, shaped: isShapedLine(c) },
        curCount: c ? pendingCount(c) : 0,
        beforeCount: pendingCount(b),
        changed: d !== b,
      })
    )
      continue;
    // only the unit fields: a note (or any other edit) typed while the units loaded must survive the merge (N3)
    out = out.map((li) => (li.tempId === d.tempId ? { ...li, ...pickUnitFields(d) } : li));
  }
  return out;
}
