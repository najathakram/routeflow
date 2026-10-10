import {
  PIECE_LABEL,
  computeLineSubtotal,
  defaultSellingLabel,
  resolveLadderLevel,
  resolveUnitPrice,
  roundMoney,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { formatMoney, formatQty } from "@/lib/format";

/**
 * One sellable level of a product's ladder, as the unit picker offers it (units_v1, step 5a).
 * Everything here is DISPLAY: the server re-resolves the factor and price from the ladder by label
 * on every write, so a stale option can never change what is stored.
 */
export interface UnitOption {
  /** What the picker sends as `unitLabel`; `""` = the pack (no unitLabel — today's behaviour). */
  value: string;
  label: string;
  /** Pieces per ONE of this unit. */
  factorToBase: number;
  kind: "pack" | "piece" | "level";
  /** Price per ONE of this unit at the customer's tier (`resolveUnitPrice`, same as the server). */
  price: number;
  /** The same unit's TIER-1 price — what a typed one-time price is compared against (server rule). */
  listPrice: number;
}

const norm = (s: string) => s.trim().toLowerCase();

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
 * The ladder a picker offers: the pack first (its `value` is `""`), then each level largest → smallest,
 * then the implicit Piece when nothing else already sells single pieces. A row named like the pack is
 * shadowed by the pack, exactly as `resolveLadderLevel` does server-side; a factor-1 row named "Piece"
 * is not an extra option — it supplies the Piece's explicit price (priced through the same ladder).
 * A product with no levels yields ONE option (the pack) — callers render no picker at all then.
 */
export function buildUnitOptions(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
  /**
   * The price the parent already shows for the PACK. A pack line goes through the order pricing
   * pipeline (remembered above-list price, promotions), which the ladder alone cannot know; a
   * level's price is exactly the ladder's (promos/upsell are pack-only). Omitted = the tier price.
   */
  packPrice?: number,
): UnitOption[] {
  const ladder = units.map(toLadderUnit);
  const price = (label: string) => resolveUnitPrice(product, ladder, label, tier);
  const list = (label: string) => resolveUnitPrice(product, ladder, label, 1);
  const pack = resolveLadderLevel(product, ladder, "");
  const options: UnitOption[] = [
    {
      value: "",
      label: pack.label,
      factorToBase: pack.factorToBase,
      kind: "pack",
      price: packPrice ?? price(""),
      listPrice: list(""),
    },
  ];
  const seen = new Set([norm(pack.label), norm(PIECE_LABEL)]);
  const rows = ladder
    .filter((l) => Number.isInteger(l.factorToBase) && l.factorToBase >= 1)
    .sort((a, b) => b.factorToBase - a.factorToBase);
  for (const u of rows) {
    if (seen.has(norm(u.label))) continue;
    seen.add(norm(u.label));
    options.push({
      value: u.label,
      label: u.label,
      factorToBase: u.factorToBase,
      kind: u.factorToBase === 1 ? "piece" : "level",
      price: price(u.label),
      listPrice: list(u.label),
    });
  }
  // gate on the ladder, not on `options`: a ladder whose only row is the explicit Piece (or is
  // shadowed) still sells singles, and a product with NO rows stays a single-option pack
  if (rows.length > 0 && !options.some((o) => o.factorToBase === 1)) {
    options.push({
      value: PIECE_LABEL,
      label: PIECE_LABEL,
      factorToBase: 1,
      kind: "piece",
      price: price(PIECE_LABEL),
      listPrice: list(PIECE_LABEL),
    });
  }
  return options;
}

/**
 * The unit a new line starts on: the level flagged `isDefaultSelling` — only if the picker actually
 * offers it (a shadowed/corrupt row would otherwise hold the line on a label nobody can see) — else
 * the pack (`""`).
 */
export function defaultUnitValue(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
): string {
  // #2784: the ONE resolver (@routeflow/pricing) — the server's buyer-qty default reads the same function.
  const flagged = defaultSellingLabel(product, units.map(toLadderUnit));
  if (!flagged) return "";
  const offered = buildUnitOptions(product, units, tier).find(
    (o) => o.kind !== "pack" && norm(o.value) === norm(flagged),
  );
  return offered?.value ?? "";
}

/** The dropdown text: "Case · 288 pcs · $480.00". */
export function unitOptionText(o: UnitOption): string {
  const pcs = o.factorToBase === 1 ? "" : ` · ${formatQty(o.factorToBase)} pcs`;
  return `${o.label}${pcs} · ${formatMoney(o.price)}`;
}

/** Line total for `count` of a unit at `unitPrice` — the same rounding the server applies. */
export function unitLineSubtotal(option: UnitOption, count: number, unitPrice?: number): number {
  const n = Math.trunc(Number(count));
  if (!(n > 0)) return 0;
  const price = unitPrice ?? option.price;
  return option.factorToBase === 1
    ? roundMoney(price * n)
    : computeLineSubtotal({
        unitPrice: price,
        qty: n * option.factorToBase,
        boxes: n,
        pieces: 0,
        unitsPerBox: option.factorToBase,
      });
}
