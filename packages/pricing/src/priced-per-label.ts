/**
 * B1383 (SA-1281 part 2): the ONE place a product price's label and per-piece hint are built. On a product with
 * `unitsPerBox` > 1 the stored price is the BOX price, so its label names the box ("Price per box (12 cans)") even when
 * the product's unit is a piece word ("can"); the hint under it names the piece ("≈ $0.10 / can"). Display only: the
 * hint is `perUnitPrice` (never in a payload). Web, mobile and any scan of copy read this; no caller builds the text.
 */
import { GENERIC_PIECE } from "./line-counts";
import { formatReceiptMoney, priceUnitWord } from "./receipt-line-detail";
import { perUnitPrice } from "./pricing";
import { plural, unitWords } from "./unit-words";

const PACKISH = new Set(["box", "case", "carton", "pack", "crate", "bundle"]);

/** True when the selling unit is a pack word ("case") or the tenant's own pack name. */
export function isPackUnitWord(
  unit: string | null | undefined,
  packLabel?: string | null,
): boolean {
  const t = priceUnitWord(unit);
  if (t === "unit") return false;
  const w = unitWords({ packLabel });
  return PACKISH.has(t) || t === w.pack.lower || t === w.pack.lowerOther;
}

export interface PricedPerLabel {
  /** The quoting phrase without "Price": "per box", "per case", "each", "per lb". For a compact "per box" line. */
  per: string;
  /** `per` plus `detail`: "per box (12 cans)", for a buyer tile line. */
  perText: string;
  /** The bare word the price is quoted per: "box", "case", "each", "lb". For a compact "$1.25 / box" line. */
  word: string;
  /** "Price per box", "Price per case", "Price each", "Price per lb". */
  short: string;
  /** "12 cans" when the price is a box price named after a piece word, else null. */
  detail: string | null;
  /** `short` plus `detail`: "Price per box (12 cans)". */
  label: string;
  /** "≈ $0.10 / can" for a boxed product with a price; null otherwise. */
  hint: string | null;
  /** The pieces of `hint`, for a screen that styles the money: the per-piece price and its word ("can"). */
  perPiece: { price: number; word: string } | null;
}

export function pricedPerLabel(p: {
  unit?: string | null;
  unitsPerBox?: number | null;
  packLabel?: string | null;
  baseUnitLabel?: string | null;
  /** The stored (box) price, for the hint. */
  price?: number | null;
}): PricedPerLabel {
  const packSize = Number(p.unitsPerBox ?? 0);
  const boxed = Number.isFinite(packSize) && packSize > 1;
  const given = (p.unit ?? "").trim();
  const word = priceUnitWord(given);
  const w = unitWords({ packLabel: p.packLabel, baseUnitLabel: p.baseUnitLabel });
  const isPack = isPackUnitWord(given, p.packLabel);
  const plain = !given || GENERIC_PIECE.test(word);
  // the piece the box holds: the product's own piece word, else the tenant's base word ("piece")
  const piece = plain || isPack ? w.base.lower : word;

  let per: string;
  let quoted: string;
  let detail: string | null = null;
  // a boxed product always says how many pieces the pack holds ("per case (12 pieces)", "per box (12 cans)")
  if (boxed) detail = `${packSize} ${plural(piece, packSize)}`;
  if (boxed && !isPack) {
    quoted = w.pack.lower;
    per = `per ${quoted}`;
  } else if (word === "each") {
    quoted = "each";
    per = "each";
  } else {
    quoted = given || "unit";
    per = `per ${quoted}`;
  }
  const short = `Price ${per}`;

  const pu = p.price == null ? null : perUnitPrice(Number(p.price), boxed ? packSize : null);
  const hintWord = isPack ? w.base.short.one : piece;
  return {
    per,
    perText: detail ? `${per} (${detail})` : per,
    word: quoted,
    short,
    detail,
    label: detail ? `${short} (${detail})` : short,
    hint: pu == null ? null : `≈ ${formatReceiptMoney(pu)} / ${hintWord}`,
    perPiece: pu == null ? null : { price: pu, word: hintWord },
  };
}
