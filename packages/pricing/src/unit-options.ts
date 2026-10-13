import { computeLineSubtotal, roundMoney } from "./pricing";
import {
  baseLabelOf,
  defaultSellingLabel,
  describeBaseOption,
  resolveLadderLevel,
  resolveUnitPrice,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

// The ladder a unit picker OFFERS (units rebuild P0b / SA-728), shared by the web and mobile
// `buildUnitOptions` so the two twins can never disagree. Display only — the server re-resolves the
// factor and price from the ladder by label on every write.

export interface LadderOption {
  /** What the picker sends as `unitLabel`; `""` = the pack (no unitLabel). */
  value: string;
  label: string;
  /** Pieces per ONE of this unit. */
  factorToBase: number;
  kind: "pack" | "piece" | "level";
  /** Price per ONE of this unit at the customer's tier (`resolveUnitPrice`, same as the server). */
  price: number;
  /** The same unit's TIER-1 price — what a typed one-time price is compared against (server rule). */
  listPrice: number;
  /**
   * Present ONLY on a base option with NO price of its own: it bills as the pack line's pieces
   * (computeLineSubtotal proration), so `price` is a DISPLAY figure — never qty x price.
   */
  derived?: { n: number; packPrice: number; exact: boolean };
}

/**
 * Units P0b / SA-728: the ONE declaration of the client-only `derivedBase` marker, shared by web and mobile (a
 * type only, so it adds nothing at runtime). A DERIVED base option (`LadderOption.derived`) is sold as a PACK-PIECES
 * line (boxes/pieces, no `unitLabel`) so the preview and the payload are the server's own proration; this marker
 * is the option `value` the picker keeps showing for such a line. It is display state: NEVER submitted. A pack-pieces
 * line WITHOUT it is a pack line, never guessed into a Piece.
 */
export interface DerivedBaseMarker {
  derivedBase?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildLadderOptions(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tier: number | string = 1,
  /** The price the parent already shows for the PACK (promotions / remembered upsell). Omitted = the tier price. */
  packPrice?: number,
): LadderOption[] {
  const price = (label: string) => resolveUnitPrice(product, units, label, tier);
  const list = (label: string) => resolveUnitPrice(product, units, label, 1);
  const pack = resolveLadderLevel(product, units, "");
  const baseLabel = baseLabelOf(product);
  const options: LadderOption[] = [
    {
      value: "",
      label: pack.label,
      factorToBase: pack.factorToBase,
      kind: "pack",
      price: packPrice ?? price(""),
      listPrice: list(""),
    },
  ];
  // A row named like the pack is shadowed by it (by packLabel OR the legacy unit text); the base's own
  // factor-1 row is folded into the ONE base option below, never listed twice.
  const seen = new Set([
    norm(pack.label),
    norm(product.unit ?? ""),
    norm(baseLabel),
    norm("Piece"),
  ]);
  const rows = units
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
  // gate on the ladder, not on `options`: a ladder whose only row is the explicit base (or is
  // shadowed) still sells singles, and a product with NO rows stays a single-option pack
  if (rows.length > 0 && !options.some((o) => o.factorToBase === 1)) {
    const base: LadderOption = {
      value: baseLabel,
      label: baseLabel,
      factorToBase: 1,
      kind: "piece",
      price: price(baseLabel),
      listPrice: list(baseLabel),
    };
    const info = describeBaseOption(product, units, tier);
    if (info.source === "derived" && info.fractionOf && info.fractionOf.n > 1) {
      base.derived = { ...info.fractionOf, exact: info.exact };
    }
    options.push(base);
  }
  return options;
}

/** The value the picker starts on: the level flagged `isDefaultSelling` that the picker actually offers, else the pack (`""`). */
export function defaultLadderOptionValue(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tier: number | string = 1,
): string {
  const flagged = defaultSellingLabel(product, units);
  if (!flagged) return "";
  const factor = resolveLadderLevel(product, units, flagged).factorToBase;
  const offered = buildLadderOptions(product, units, tier).find(
    (o) => o.kind !== "pack" && (norm(o.value) === norm(flagged) || o.factorToBase === factor),
  );
  return offered?.value ?? "";
}

/** The money part of an option's text: the exact price, or "≈$x (1/n of $P)" when a derived base is not exact to the cent. */
export function ladderOptionPriceText(o: LadderOption, fmt: (n: number) => string): string {
  if (o.derived && !o.derived.exact) {
    return `≈${fmt(o.price)} (1/${o.derived.n} of ${fmt(o.derived.packPrice)})`;
  }
  return fmt(o.price);
}

/**
 * Line total for `count` of an option. A derived base is the pack line's pieces (proration), never
 * count x a rounded per-piece price; an own-priced base or a level is count x its price (a level at a
 * typed `unitPrice` too).
 */
export function ladderOptionLineTotal(o: LadderOption, count: number, unitPrice?: number): number {
  const n = Math.trunc(Number(count));
  if (!(n > 0)) return 0;
  if (o.derived && unitPrice == null) {
    return computeLineSubtotal({
      unitPrice: o.derived.packPrice,
      qty: n,
      boxes: 0,
      pieces: n,
      unitsPerBox: o.derived.n,
    });
  }
  const price = unitPrice ?? o.price;
  return o.factorToBase === 1
    ? roundMoney(price * n)
    : computeLineSubtotal({
        unitPrice: price,
        qty: n * o.factorToBase,
        boxes: n,
        pieces: 0,
        unitsPerBox: o.factorToBase,
      });
}
