import type { ProductUnitLevel } from "@routeflow/types";
import {
  applyLineUnit,
  ladderProductOf,
  mergeSameLine,
  sameProductUnit,
  type UnitLine,
} from "@/lib/order-line-unit";
import { buildUnitOptions, defaultUnitValue, type UnitOption } from "@/lib/unit-options";

/**
 * SA-626c (tier 1 money): the default selling unit belongs to the LINE, never to a mounted row. A line flagged
 * `startOnDefaultUnit` (picker tap, shared-code scan, multi-match pick) is moved onto the product's default unit by
 * THIS module once the ladder is known, so the order the operator submits carries a stored unit. The row's
 * OrderLineUnitPicker resolves through the same predicate and writer, so there is one rule and no second copy.
 */

type Tier = number;

/** The line fields the rule reads (structurally satisfied by the modal's LineItem). */
export interface DefaultUnitLine extends UnitLine {
  tempId: string;
  productId: string;
  isUnlisted?: boolean;
  startOnDefaultUnit?: boolean;
  priceEdited?: boolean;
}

/**
 * The operator has shaped this line (a unit, a typed price): never start it on the default. A price the SYSTEM pre-filled
 * from the customer's history (DISCOUNTED/MANUAL + discountedPrice at add time) is NOT a shape: a remembered price never
 * decides the unit (owner ruling SA-626d). Every operator price handler consumes the flag, so a still-set flag means untouched.
 */
export function isShapedLine(line: { unitLabel?: string; priceEdited?: boolean }): boolean {
  return !!line.unitLabel || !!line.priceEdited;
}

/** Does this add keep (or start) the default-start flag? A default-start add to a still-pending line only. */
export function keepsDefaultStart(prev: DefaultUnitLine, dflt?: boolean): boolean {
  return !!dflt && isPendingDefaultUnit(prev);
}

/** Fast adds before the ladder loaded: N adds = N of the default unit (a boxed line's qty is total pieces). */
export function pendingCount(line: UnitLine): number {
  return Math.max(
    1,
    line.unitsPerBox ? (line.boxes ?? Math.round(line.qty / line.unitsPerBox)) : line.qty,
  );
}

/** Still waiting for its default unit. Qty is not a guard (on a boxed line it is total pieces). */
export function isPendingDefaultUnit(line: DefaultUnitLine): boolean {
  return line.startOnDefaultUnit === true && !isShapedLine(line);
}

/**
 * The ONE writer of a chosen unit on an order's lines (the picker's onChange and the default start): switches the line,
 * CONSUMES the default-start flag, and folds into a twin line of the same product + unit.
 */
export function applyUnitToLines<T extends DefaultUnitLine>(
  prev: T[],
  tempId: string,
  option: UnitOption,
  refresh: boolean,
  tier: Tier,
): T[] {
  const target = prev.find((li) => li.tempId === tempId);
  if (!target) return prev;
  // startOnDefaultUnit is CONSUMED by any unit choice (incl. the pack): a remount can never re-apply the default over
  // the operator's choice (Opus #2865 B1).
  const next = {
    ...applyLineUnit(target, option, { tier, keepQty: refresh }),
    startOnDefaultUnit: false,
    // A still-pending line keeps its count (N fast adds = N of the unit); any other choice resets to 1, as always.
    ...(option.kind !== "pack" && isPendingDefaultUnit(target)
      ? { qty: pendingCount(target) }
      : {}),
  };
  const twin = prev.find((li) => li.tempId !== tempId && sameProductUnit(li, next));
  if (!twin) return prev.map((li) => (li.tempId === tempId ? next : li));
  return prev
    .filter((li) => li.tempId !== tempId)
    .map((li) => (li.tempId === twin.tempId ? mergeSameLine(li, next) : li));
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
  return (only as T | undefined) ?? { ...line, startOnDefaultUnit: false };
}

export interface DefaultUnitDeps {
  /** `flag.units_v1`: with it off there is no ladder, so the pack is the only unit. */
  unitsEnabled: boolean;
  /** False while the subscription answer is still loading: "off" is not yet known, so nothing may be resolved. */
  unitsKnown: boolean;
  getUnits: (productId: string) => Promise<ProductUnitLevel[]>;
  tierFor: (productId: string) => Tier;
}

/**
 * Resolves every pending line, fetching the ladder when it is not cached. A line whose ladder cannot be loaded is
 * reported in `blocked` (by tempId) and left untouched: the caller refuses to submit rather than send the pack by default.
 */
export async function resolvePendingDefaultUnits<T extends DefaultUnitLine>(
  lines: T[],
  deps: DefaultUnitDeps,
): Promise<{ lines: T[]; blocked: string[] }> {
  let out = lines;
  const blocked: string[] = [];
  for (const line of lines) {
    if (!isPendingDefaultUnit(line)) continue;
    if (line.isUnlisted || (deps.unitsKnown && !deps.unitsEnabled)) {
      out = out.map((li) =>
        li.tempId === line.tempId ? { ...li, startOnDefaultUnit: false } : li,
      );
      continue;
    }
    if (!deps.unitsKnown) {
      blocked.push(line.tempId);
      continue;
    }
    try {
      const units = await deps.getUnits(line.productId);
      const tier = deps.tierFor(line.productId);
      const option = defaultOptionFor(line, units, tier);
      out = option
        ? applyUnitToLines(out, line.tempId, option, false, tier)
        : out.map((li) => (li.tempId === line.tempId ? { ...li, startOnDefaultUnit: false } : li));
    } catch {
      blocked.push(line.tempId);
    }
  }
  return { lines: out, blocked };
}

/** An async resolve never overwrites what the operator did meanwhile: apply it only to a line still pending. */
export function mergeResolvedLines<T extends DefaultUnitLine>(
  cur: T[],
  before: T[],
  done: T[],
): T[] {
  let out = cur;
  for (const d of done) {
    const b = before.find((li) => li.tempId === d.tempId);
    const c = out.find((li) => li.tempId === d.tempId);
    // still pending AND the same count: a 2nd fast add that landed while this resolved must not be overwritten
    if (!b || d === b || !c || !isPendingDefaultUnit(c) || pendingCount(c) !== pendingCount(b))
      continue;
    out = out.map((li) => (li.tempId === d.tempId ? d : li));
  }
  return out;
}
