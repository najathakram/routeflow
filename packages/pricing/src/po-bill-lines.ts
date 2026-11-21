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

/** Pure. `piecesToBill` is per PO line, in pieces; it defaults to `billQuantitiesFromPO`. Lines of 0 are left out. */
export function billLinesFromPO(
  poLines: readonly PoLineForBill[],
  piecesToBill: readonly number[] = billQuantitiesFromPO(poLines),
): BillLineFromPO[] {
  const out: BillLineFromPO[] = [];
  poLines.forEach((line, i) => {
    const n = Number(piecesToBill[i] ?? 0);
    if (!(n > 0)) return;
    const ordered = Number(line.qtyOrdered);
    const total = Number(line.totalCost);
    const unit = Number(line.unitCost);
    const packRaw = Math.trunc(Number(line.packSize ?? 0));
    const pack = packRaw > 1 ? packRaw : null;
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

    // A fractional quantity (a weighed item) cannot be a lot: the pack is a whole number of pieces.
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
