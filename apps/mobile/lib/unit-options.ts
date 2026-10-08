import {
  buildLadderOptions,
  defaultLadderOptionValue,
  ladderOptionLineTotal,
  ladderOptionPriceText,
  type LadderOption,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";

/**
 * Mobile mirror of `apps/web/lib/unit-options.ts` (units_v1) — same contract, same
 * `@routeflow/pricing` primitives, so the ladder a mobile picker offers can never disagree with
 * web's. The FORMATTING wrapper (`unitOptionText`) is necessarily a second copy (mobile cannot
 * import `apps/web`) — `__tests__/unit-options.test.ts` pins it against web's own test's exact
 * expected strings so the two can't drift silently. A follow-up to extract both `unit-options.ts`
 * copies into a shared package is filed separately, not done here.
 */

export type UnitOption = LadderOption;

/** The API returns Decimal strings; the pricing ladder takes them as-is. */
const toLadderUnit = (u: ProductUnitLevel): LadderUnit => ({
  label: u.label,
  factorToBase: u.factorToBase,
  isDefaultSelling: u.isDefaultSelling,
  price: u.price,
  priceTier2: u.priceTier2,
  priceTier3: u.priceTier3,
  priceTier4: u.priceTier4,
  priceTier5: u.priceTier5,
});

/**
 * The ladder a picker offers: the pack first (its `value` is `""`), then each level largest →
 * smallest, then the one base option. Web's `buildUnitOptions` and this one are the SAME function
 * (`buildLadderOptions` in `@routeflow/pricing`, SA-728) — see it for the per-rule rationale
 * (shadowing, the explicit base row folding into the one base option, "no levels" = one option).
 */
export function buildUnitOptions(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
  packPrice?: number,
): UnitOption[] {
  return buildLadderOptions(product, units.map(toLadderUnit), tier, packPrice);
}

/**
 * The correct base a line's `unitPrice` must be compared against to decide "is this a genuine
 * operator override" — the pack's `catalogPrice` while no unit is selected, else the ACTIVE
 * unit's own resolved price (`unitBasePrice`, set alongside `unitPrice` whenever a `UnitPickerRow`
 * choice is applied — see `NewOrderScreen.tsx`'s `setUnitLabel` / `edit-items.tsx`'s
 * `setUnitLabel`). Comparing a unit line's price against the PACK's instead — as every price-
 * comparison site in both screens originally did — misclassifies EVERY untouched unit selection
 * as a manual override, since a Case's price is never the Box's even with nothing typed (the same
 * defect shape as B465 on #1252: a comparison baseline that doesn't move when its subject does).
 *
 * Falls back to `catalogPrice` when `unitBasePrice` is unset — an existing order line loaded
 * already unit-aware this session hasn't touched yet has no `unitBasePrice` snapshot (mobile
 * keeps none, unlike web's `packBase`), so it keeps today's pre-existing behaviour for that case
 * unchanged (not fixed here) until the operator's own pick sets one.
 */
export function unitPriceBase(
  line: { unitLabel?: string | null; unitBasePrice?: number },
  catalogPrice: number,
): number {
  return line.unitLabel ? (line.unitBasePrice ?? catalogPrice) : catalogPrice;
}

/**
 * The pieces-per-unit basis a line's margin/floor hint multiplies per-piece cost by
 * (SA-085f HIGH #3) — the chosen unit's OWN factor (`unitFactor`, set alongside
 * `unitBasePrice` by `setUnitLabel`), never the pack's `unitsPerBox`: a Case's cost is
 * cost-per-piece × the CASE's factor, which for a level spanning several packs (a Pallet of
 * 10 cases) is not `unitsPerBox` at all; a Piece must not inherit the pack's whole-case cost
 * either. Falls back to the pack's own factor while no unit is selected — today's behaviour,
 * unchanged.
 */
export function marginFactorFor(
  line: { unitLabel?: string | null; unitFactor?: number },
  packUnitsPerBox?: number | null,
): number | null | undefined {
  return line.unitLabel ? (line.unitFactor ?? 1) : packUnitsPerBox;
}

// ─── Display formatting (mobile has no shared `lib/format.ts` — see file doc) ──────────────────

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function formatMoney(value: number): string {
  return moneyFmt.format(Number.isFinite(value) ? value : 0);
}

/** Whole numbers render bare ("61"), fractional quantities keep up to 2 dp ("1.5"). */
function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * The unit a new line starts on (#2784): the level flagged `isDefaultSelling` — only if the picker actually offers it —
 * else the pack (`""`). Mirrors web's `defaultUnitValue`; both call `@routeflow/pricing`'s `defaultSellingLabel`.
 */
export function defaultUnitValue(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
): string {
  return defaultLadderOptionValue(product, units.map(toLadderUnit), tier);
}

/**
 * #2784: the picker option a NEW line should be moved onto, or null (stay on the pack). Null when the line already holds
 * a unit or the operator typed its price, when nothing is flagged, or the flagged level is not offered.
 */
export function defaultStartOption(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string,
  line: { hasUnit: boolean; priceEdited?: boolean },
): UnitOption | null {
  if (line.hasUnit || line.priceEdited) return null;
  const value = defaultUnitValue(product, units, tier);
  if (!value) return null;
  return buildUnitOptions(product, units, tier).find((o) => o.value === value) ?? null;
}

/** The picker row's detail line, e.g. "240 pcs · $220.00" — everything `unitOptionText` shows
 *  after the label. A factor-1 unit (Piece) omits the piece count: "$1.75". */
export function unitOptionDetail(o: UnitOption): string {
  const pcs = o.factorToBase === 1 ? "" : `${formatQty(o.factorToBase)} pcs · `;
  return `${pcs}${ladderOptionPriceText(o, formatMoney)}`;
}

/**
 * The full option text: "Case · 240 pcs · $220.00". PINNED against web's own
 * `unit-options.test.ts` expected strings (see this file's test) — never re-derive by hand.
 */
export function unitOptionText(o: UnitOption): string {
  return `${o.label} · ${unitOptionDetail(o)}`;
}

/** Line total for `count` of a unit — a derived Piece prorates off the pack, the rest bill count x price like the server. */
export function unitLineSubtotal(option: UnitOption, count: number, unitPrice?: number): number {
  return ladderOptionLineTotal(option, count, unitPrice);
}
