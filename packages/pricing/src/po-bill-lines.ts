import { derivedCaseCost } from "./po-line";
import { roundMoney } from "./pricing";
import { DEFAULT_BASE_LABEL, DEFAULT_PACK_LABEL, plural } from "./unit-words";

/**
 * SA-1207 P2a: fill a supplier bill from a purchase order, in the PO's own units.
 *
 * A bare bill `qty` means BOXES to the API, and a bill line's money is `qty x unitCost` in the line's OWN
 * unit; it is never re-derived through a 4-decimal piece cost (122 x 0.2083 is not the 25.42 the PO
 * stores). Per PO line, for `n` pieces to bill, at the PO line's STORED pack (never the live catalog pack):
 *  - whole boxes whose case line reproduces the stored total exactly: a case line (boxes, case cost, pack);
 *  - any other boxed line: ONE lot (qty 1, `packSize` = the pieces billed, `unitCost` = the stored total
 *    pro rata via roundMoney, `unitLabel` from `lotUnitLabel`);
 *  - a piece line: `n x unitCost` when that equals the stored total, else a lot.
 * "Exactly" is compared in integer 1e-4 units, so a multi-line bill sums to the stored totals.
 */

export interface PoLineForBill {
  id?: string | null;
  productId: string;
  sku?: string | null;
  /** Pieces ordered (Decimal(10,3)). */
  qtyOrdered: number | string;
  /** Pieces received so far; null/absent = none. */
  qtyReceived?: number | string | null;
  /** Per PIECE, 4 dp. */
  unitCost: number | string;
  /** The stored line total, 2 dp. */
  totalCost: number | string;
  /** The pack the PO line was entered in (null = per piece). Never the live catalog pack. */
  packSize?: number | null;
}

/** A bill line in the line's own unit: `qty` and `unitCost` are boxes (or 1 lot, or pieces) and money per that. */
export interface BillLineFromPO {
  poItemId: string | null;
  productId: string;
  sku: string | null;
  qty: number;
  unitCost: number;
  packSize: number | null;
  /** Non-null on a lot: the line states its own unit ("5 Boxes + 2 Pieces"). */
  unitLabel: string | null;
}

const n4 = (n: number) => Math.round(n * 1e4);

/** A lot's own-unit name, in box and piece words only. */
export function lotUnitLabel(pieces: number, packSize?: number | null): string {
  const n = Math.trunc(pieces);
  const pack = Math.trunc(Number(packSize ?? 0));
  const pcs = (k: number) => `${k} ${plural(DEFAULT_BASE_LABEL, k)}`;
  if (pack > 1 && n >= pack) {
    const boxes = Math.floor(n / pack);
    const box = `${boxes} ${plural(DEFAULT_PACK_LABEL, boxes)}`;
    return n % pack === 0 ? box : `${box} + ${pcs(n % pack)}`;
  }
  return pcs(n);
}

/** Pieces to bill per PO line: what was received if anything was (capped at the order), else what was ordered. */
export function billQuantitiesFromPO(poLines: readonly PoLineForBill[]): number[] {
  const anyReceived = poLines.some((l) => Number(l.qtyReceived ?? 0) > 0);
  return poLines.map((l) =>
    anyReceived
      ? Math.min(Math.max(Number(l.qtyReceived ?? 0), 0), Number(l.qtyOrdered))
      : Number(l.qtyOrdered),
  );
}

/** The PO line's stored pack when it has one (a whole number above 1), else null. */
const packOf = (line: PoLineForBill): number | null => {
  const pack = Math.trunc(Number(line.packSize ?? 0));
  return pack > 1 ? pack : null;
};

const notPrefilled = (line: PoLineForBill, n: number): boolean =>
  n > 0 && !Number.isInteger(n) && packOf(line) !== null;

/**
 * SA-1207 A3: a fractional quantity on a boxed line (one with a pack) is never prefilled. It is neither a piece
 * line at the 4 dp cost nor a lot (a lot writes `packSize` = the pieces, an Int column). A piece line (no pack)
 * keeps `n x unitCost`. Returns the `poItemId` (the index when the id is null) of each such line, for the
 * caller to show as "Enter this line by hand". `piecesToBill` defaults to `billQuantitiesFromPO`.
 */
export function poLinesNotPrefilled(
  poLines: readonly PoLineForBill[],
  piecesToBill: readonly number[] = billQuantitiesFromPO(poLines),
): string[] {
  return poLines.flatMap((line, i) => {
    const n = Number(piecesToBill[i] ?? 0);
    return notPrefilled(line, n) ? [line.id ?? String(i)] : [];
  });
}

/** Pure. `piecesToBill` is per PO line, in pieces; it defaults to `billQuantitiesFromPO`. Lines of 0 are left out, and so are those `poLinesNotPrefilled` lists. */
export function billLinesFromPO(
  poLines: readonly PoLineForBill[],
  piecesToBill: readonly number[] = billQuantitiesFromPO(poLines),
): BillLineFromPO[] {
  const out: BillLineFromPO[] = [];
  poLines.forEach((line, i) => {
    const n = Number(piecesToBill[i] ?? 0);
    if (!(n > 0) || notPrefilled(line, n)) return;
    const ordered = Number(line.qtyOrdered);
    const total = Number(line.totalCost);
    const unit = Number(line.unitCost);
    const pack = packOf(line);
    const base = { poItemId: line.id ?? null, productId: line.productId, sku: line.sku ?? null };
    const piece = (qty: number, unitCost: number): BillLineFromPO => ({
      ...base,
      qty,
      unitCost,
      packSize: null,
      unitLabel: null,
    });
    const target =
      n === ordered || !(ordered > 0) ? roundMoney(total) : roundMoney((total * n) / ordered);

    // A fractional quantity on a piece line (a weighed item) cannot be a lot: the pack is a whole number of pieces.
    // A fractional quantity on a boxed line never gets here (poLinesNotPrefilled).
    if (!Number.isInteger(n)) return void out.push(piece(n, unit));

    if (pack && n % pack === 0) {
      const boxes = n / pack;
      const caseCost = derivedCaseCost(unit, pack, { totalCost: total, qtyOrdered: ordered });
      if (n4(caseCost) * boxes === n4(target)) {
        return void out.push({
          ...base,
          qty: boxes,
          unitCost: caseCost,
          packSize: pack,
          unitLabel: null,
        });
      }
    } else if (!pack && n4(unit) * n === n4(target)) {
      return void out.push(piece(n, unit));
    }
    if (n === 1) return void out.push(piece(1, target));
    out.push({ ...base, qty: 1, unitCost: target, packSize: n, unitLabel: lotUnitLabel(n, pack) });
  });
  return out;
}

/** SA-1207 P2b F1/F2: every PO line accounted for, in one call, keyed by INDEX (ids can be null or repeat). */
export interface BillPlanFromPO {
  lines: BillLineFromPO[];
  /** `lineIndex[k]` = the index in `poLines` that `lines[k]` came from. */
  lineIndex: number[];
  /** Indexes to enter by hand. */
  byHand: number[];
  /** Indexes whose quantity to bill is explicitly 0. */
  zero: number[];
}

export function billPlanFromPO(
  poLines: readonly PoLineForBill[],
  piecesToBill: readonly number[] = billQuantitiesFromPO(poLines),
): BillPlanFromPO {
  const lines = billLinesFromPO(poLines, piecesToBill);
  const lineIndex = poLines.flatMap((l, i) =>
    lines.some((x) => x.productId === l.productId) ? [i] : [],
  );
  const byHand = poLines.flatMap((l, i) =>
    notPrefilled(l, Number(piecesToBill[i] ?? 0)) ? [i] : [],
  );
  const zero = poLines.flatMap((_, i) => (lineIndex.includes(i) || byHand.includes(i) ? [] : [i]));
  return { lines, lineIndex, byHand, zero };
}
