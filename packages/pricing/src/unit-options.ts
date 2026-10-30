import { computeLineSubtotal, normalizeBoxesPieces, roundMoney } from "./pricing";
import { heldSnapshotPrices } from "./held-level";
import {
  baseLabelOf,
  defaultSellingLabel,
  describeBaseOption,
  resolveLadderLevel,
  resolveUnitPrice,
  unitNameKey,
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
  /** SA-1044: a gone-or-resized held line's own snapshot (`heldSnapshotOption`); its label already names the size. */
  held?: true;
}

/**
 * Units P0b / SA-728: the ONE declaration of the client-only `derivedBase` marker, shared by web and mobile (a
 * type only, so it adds nothing at runtime). A DERIVED base option (`LadderOption.derived`) is sold as a PACK-PIECES
 * line (boxes/pieces, no `unitLabel`) so the preview and the payload are the server's own proration; this marker
 * is the option `value` the picker keeps showing for such a line. It is display state: NEVER submitted. A pack-pieces
 * line WITHOUT it is a pack line, never guessed into a Piece.
 */
export type DerivedBaseMarker = {
  derivedBase?: string;
};

// The shared label key (NFC, trim, case-fold): the same one the server ladder compares by (SA M2).
const norm = unitNameKey;

export function buildLadderOptions(
  product: LadderProduct,
  units: readonly LadderUnit[],
  tier: number | string = 1,
  /** The price the parent already shows for the PACK (promotions / remembered upsell). Omitted = the tier price. */
  packPrice?: number,
  /**
   * S19b, flag.units_prices_v2 only (from `customerLinePrice`): the pack's CUSTOMER-LAYER price. A derived base (Piece) bills as the
   * pack's pieces at that price, so its option reads 1/n of it. Separate from `packPrice`, whose meaning is unchanged: callers pass
   * the line's CURRENT price there (a one-time override included), and the derived base then stays on the tier ladder, as on master.
   */
  layerPackPrice?: number,
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
      const n = info.fractionOf.n;
      // master: the tier ladder. Only the flag-on customer-layer pack price (never `packPrice`) moves the derived base.
      const pack = layerPackPrice ?? info.fractionOf.packPrice;
      const cents = (pack * 100) / n;
      base.derived = {
        n,
        packPrice: pack,
        exact: layerPackPrice == null ? info.exact : Math.abs(cents - Math.round(cents)) < 1e-9,
      };
      if (layerPackPrice != null) base.price = roundMoney(pack / n);
    }
    options.push(base);
  }
  return options;
}

/**
 * SA-1044 rule 4: the option a gone-or-resized held line shows — its OWN snapshot (label, size, price), never the live
 * level of that name, so the line cannot silently take the new size. "Case of 100 (as ordered)".
 */
export function heldSnapshotOption(held: {
  unitLabel: string;
  unitsPerBox: number;
  unitPrice: number;
  listPrice?: number | null;
}): LadderOption {
  const n = held.unitsPerBox;
  const { tierPrice, listPrice } = heldSnapshotPrices({
    unitPrice: held.unitPrice,
    originalPrice: held.listPrice,
  });
  return {
    value: held.unitLabel,
    label: `${held.unitLabel} of ${n} (as ordered)`,
    factorToBase: n,
    kind: n === 1 ? "piece" : "level",
    price: tierPrice,
    listPrice,
    held: true,
  };
}

/** `options` with `held` in place of the option of the same label (or after the rest when the ladder no longer names it). */
export function withHeldOption<T extends LadderOption>(options: readonly T[], held: T | null): T[] {
  if (!held) return [...options];
  const i = options.findIndex((o) => norm(o.value) === norm(held.value));
  return i === -1 ? [...options, held] : options.map((o, j) => (j === i ? held : o));
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
 * The detail part of an option's picker text, shared by web and mobile (row 513): "288 pcs · $480.00". A factor-1 unit
 * (Piece) omits the piece count: "$2.00". The apps pass their own formatters; both render whole numbers bare.
 */
export function ladderOptionDetail(
  o: LadderOption,
  fmtMoney: (n: number) => string,
  fmtQty: (n: number) => string,
): string {
  const pcs = o.factorToBase === 1 || o.held ? "" : `${fmtQty(o.factorToBase)} pcs · `;
  return `${pcs}${ladderOptionPriceText(o, fmtMoney)}`;
}

/** The full picker text: "Case · 288 pcs · $480.00". The one string both apps render (web's dropdown, mobile's row). */
export function ladderOptionText(
  o: LadderOption,
  fmtMoney: (n: number) => string,
  fmtQty: (n: number) => string,
): string {
  return `${o.label} · ${ladderOptionDetail(o, fmtMoney, fmtQty)}`;
}

/**
 * The pack-pieces shape of `count` pieces of a DERIVED base option (units P0b / SA-728): `boxes`/`pieces` split on the pack
 * size (the option's own `derived.n`, rolled over at a full pack), `qty` the total pieces, NO unit label. The line then
 * bills through `computeLineSubtotal` at the PACK price, the server's own proration, never `count` x a rounded per-piece
 * price. Null for any option that is not a derived base (a level, an own-priced Piece, the pack).
 */
export function derivedPackSplit(
  option: Pick<LadderOption, "derived">,
  count: number,
): { qty: number; boxes: number; pieces: number; unitsPerBox: number } | null {
  if (!option.derived) return null;
  return packPiecesSplit(option.derived.n, count);
}

/**
 * `count` loose pieces of a `unitsPerBox` pack as `{ qty, boxes, pieces }`, rolled over at a full pack: the ONE
 * place that shape is built (a hand-rolled `normalizeBoxesPieces({ boxes: 0, pieces })` elsewhere is how web, mobile
 * and the server drifted; `no-inline-pack-split.pin.spec.ts` keeps it that way).
 */
export function packPiecesSplit(
  unitsPerBox: number,
  count: number,
): { qty: number; boxes: number; pieces: number; unitsPerBox: number } {
  const n = normalizeBoxesPieces({ boxes: 0, pieces: count, unitsPerBox });
  return { qty: n.qty, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, unitsPerBox };
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
