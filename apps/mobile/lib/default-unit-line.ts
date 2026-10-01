import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState } from "./cart-line-state";
import type { LadderProduct } from "@routeflow/pricing";
import { defaultStartOption, type UnitOption } from "./unit-options";

/**
 * SA-626c (tier 1 money): the default selling unit belongs to the LINE, never to a mounted sheet. A line flagged
 * `startOnDefaultUnit` (a shared-code scan, a picker "+", the "Which one?" sheet) is moved onto the product's
 * default unit by THIS module, once the ladder is known, so the tray and Confirm read a stored unit. The cart row's
 * UnitPickerRow still resolves through the same functions, so there is one rule and no second copy.
 */

/** The ONE writer of a chosen unit (the sheet's onChange and the default start). The pack is `option.value === ""`. */
export function applyUnitOption(prev: LineState, option: UnitOption): LineState {
  const isPack = option.value === "";
  // A REMEMBERED pack price (history pre-fill) is stashed while the line sells by a unit and re-applied when the buyer
  // explicitly picks the pack again; an operator-typed price is cleared by a unit choice, as always (SA-626d).
  const remembered = prev.priceSource === "history" && prev.unitPrice != null && !prev.unitLabel;
  const restore = isPack && prev.packUnitPrice != null;
  return {
    ...prev,
    unitLabel: isPack ? undefined : option.value,
    unitBasePrice: isPack ? undefined : option.price,
    unitFactor: isPack ? undefined : option.factorToBase,
    // any unit choice CONSUMES the default-start flag (a cart re-open never re-applies it, Opus #2865 B2)
    startOnDefaultUnit: undefined,
    qty: 1,
    boxes: undefined,
    pieces: undefined,
    unitPrice: restore ? prev.packUnitPrice : undefined,
    priceSource: restore ? "history" : undefined,
    packUnitPrice: !isPack && remembered ? prev.unitPrice : undefined,
  };
}

/**
 * Still waiting for its default unit: the flag only holds while qty is untouched and the operator typed no price. A
 * REMEMBERED price (`priceSource: "history"`) is the system's pre-fill, not an operator shape, so it does not decide
 * the unit (owner ruling SA-626d).
 */
export function isPendingDefaultUnit(line: LineState | undefined): boolean {
  return (
    line?.startOnDefaultUnit != null &&
    line.startOnDefaultUnit === line.qty &&
    line.priceSource !== "operator" &&
    (line.unitPrice == null || line.priceSource === "history")
  );
}

/** Does this add keep (or start) the default-start flag? A default-start add to a NEW or still-pending line only. */
export function keepsDefaultStart(prev: LineState | undefined, dflt?: boolean): boolean {
  return !!dflt && (!prev || isPendingDefaultUnit(prev));
}

/** The line once its ladder is known: on the flagged default unit, or (nothing flagged/offered) left on the pack. */
export function startLineOnDefault(
  line: LineState,
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number,
): LineState {
  if (!isPendingDefaultUnit(line)) return line;
  const start = defaultStartOption(product, units, tier, { hasUnit: !!line.unitLabel });
  if (!start) return { ...line, startOnDefaultUnit: undefined };
  // Fast adds before the ladder loaded: N adds = N of the default unit. A boxed product's qty is total pieces.
  const upb = Number(product.unitsPerBox ?? 0);
  const count = Math.max(1, upb > 1 ? Math.round(line.qty / upb) : line.qty);
  return { ...applyUnitOption(line, start), qty: count };
}

export interface DefaultUnitDeps {
  /** `flag.units_v1`: with it off there is no ladder, so the pack is the only unit. */
  unitsEnabled: boolean;
  /** False while the subscription answer is still loading: "off" is not yet known, so nothing may be resolved. */
  unitsKnown: boolean;
  getUnits: (productId: string) => Promise<ProductUnitLevel[]>;
  productFor: (productId: string) => LadderProduct | undefined;
  tierFor: (productId: string) => number;
}

/**
 * Resolves every pending line, fetching the ladder when it is not cached. A line whose ladder cannot be loaded (or
 * whose product record is missing) is reported in `blocked` and left untouched: the caller refuses to submit rather
 * than send the pack/case by default.
 */
export async function resolvePendingDefaultUnits(
  items: Record<string, LineState>,
  deps: DefaultUnitDeps,
): Promise<{ items: Record<string, LineState>; blocked: string[] }> {
  const next = { ...items };
  const blocked: string[] = [];
  for (const [id, line] of Object.entries(items)) {
    if (!isPendingDefaultUnit(line)) continue;
    if (!deps.unitsKnown) {
      blocked.push(id);
      continue;
    }
    if (!deps.unitsEnabled) {
      next[id] = { ...line, startOnDefaultUnit: undefined };
      continue;
    }
    const product = deps.productFor(id);
    if (!product) {
      blocked.push(id);
      continue;
    }
    try {
      next[id] = startLineOnDefault(line, product, await deps.getUnits(id), deps.tierFor(id));
    } catch {
      blocked.push(id);
    }
  }
  return { items: next, blocked };
}

/** An async resolve never overwrites what the buyer did meanwhile: apply it only to a still-pending line at the same qty. */
export function mergeResolvedDefaults(
  cur: Record<string, LineState>,
  before: Record<string, LineState>,
  done: Record<string, LineState>,
): Record<string, LineState> {
  let out = cur;
  for (const id of Object.keys(done)) {
    const c = cur[id];
    if (done[id] === before[id] || !isPendingDefaultUnit(c) || c!.qty !== before[id]?.qty) continue;
    out = out === cur ? { ...cur } : out;
    out[id] = done[id]!;
  }
  return out;
}
