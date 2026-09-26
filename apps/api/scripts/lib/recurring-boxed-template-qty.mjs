/**
 * B646 / SA-135a — pure classification behind report-recurring-boxed-template-qty.mjs (no I/O).
 *
 * A recurring template line for a BOXED product (unitsPerBox > 1, no selling-unit label) is BILLED as
 * `qty x unitPrice`. Until the B646 fix the generated invoice line RECORDED that same qty as the units
 * sold (the pieces column); after the fix it records `qty x unitsPerBox` (qty read as BOXES). The bill
 * itself never changes (subtotal AND levy, pinned). Ledger units and COGS basis change: invoice creation
 * writes no stock movement, but the recorded units feed the regulated ledger, usage and COGS analytics.
 *
 * Two template shapes need the owner BEFORE the fix's first cycle:
 *   - BOX-priced but qty looks like PIECES (qty > unitsPerBox at about the box price): possibly
 *     OVER-BILLED every past cycle (qty boxes billed, pieces meant), and after the fix it records
 *     qty x unitsPerBox units. Correct it to qty / unitsPerBox boxes.
 *   - PIECES-priced (unitPrice about the box price / unitsPerBox): billed and recorded correctly until
 *     now, but after the fix it records qty x unitsPerBox units for qty pieces. Correct it to box terms.
 */
import { roundMoney } from "@routeflow/pricing";

/**
 * How the template's price relates to the product's per-box price: "pieces" (<= 1.5x the per-piece
 * price, tested FIRST), "box" (>= max(half the box price, 1.5x the per-piece price)), or "unclear" (in
 * between, a $0 price, or no product price to compare). For a 2-pack the per-piece price IS half the box
 * price, so the box band starts at 1.5/pack there: a per-piece 2-pack line is never read as box-priced.
 */
export function priceBasis(unitPrice, boxPrice, pack) {
  const box = Number(boxPrice);
  if (!(box > 0)) return "unclear";
  const ratio = Number(unitPrice) / box;
  if (!(ratio > 0)) return "unclear";
  if (ratio <= 1.5 / pack) return "pieces";
  if (ratio >= Math.max(0.5, 1.5 / pack)) return "box";
  return "unclear";
}

/**
 * @param {{ productId: string|null, qty: unknown, unitPrice: unknown, unitLabel?: string|null,
 *           unitsPerBox?: number|null, productPrice?: unknown }} line
 * @returns {null | object} null when the fix does not touch this line (not a boxed pack count).
 */
export function classifyTemplateLine(line) {
  const pack = Math.trunc(Number(line.unitsPerBox ?? 0));
  if (!line.productId || line.unitLabel || pack <= 1) return null;
  const qty = Number(line.qty);
  const unitPrice = Number(line.unitPrice);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  // Same box-aware split as recurring-line-split.ts: whole boxes plus the fraction of one box as pieces.
  const wholeBoxes = Math.floor(qty);
  const looseExact = (qty - wholeBoxes) * pack;
  const loosePieces = Math.round(looseExact);
  const splits = Math.abs(looseExact - loosePieces) <= 1e-6;

  const basis = priceBasis(unitPrice, line.productPrice, pack);
  const reasons = [];
  if (qty > pack) reasons.push("qty>unitsPerBox");
  if (!Number.isInteger(qty)) reasons.push("non-integer");
  if (basis === "pieces") reasons.push("pieces-priced");
  if (basis === "unclear") reasons.push("price-basis-unclear");

  const currentUnitsRecorded = qty; // pre-fix: qty recorded as the units sold
  const postFixUnitsRecorded = splits ? wholeBoxes * pack + loosePieces : qty;
  const billedPerCycle = roundMoney(qty * unitPrice);
  const billedIfPiecesIntent = roundMoney((qty / pack) * unitPrice);
  return {
    unitsPerBox: pack,
    qty,
    unitPrice,
    priceBasis: basis,
    flagged: reasons.length > 0,
    reasons,
    splits,
    currentUnitsRecorded,
    postFixUnitsRecorded,
    unitsRecordedDeltaPerCycle: postFixUnitsRecorded - currentUnitsRecorded,
    billedPerCycle,
    billedIfPiecesIntent,
    // Only a BOX-priced line whose qty looks like pieces can have been over-billed: a pieces-priced
    // line was billed at a per-piece price all along.
    possibleOverbillPerCycle:
      qty > pack && basis === "box" ? roundMoney(billedPerCycle - billedIfPiecesIntent) : 0,
  };
}

/** Group classified rows by tenant id (never a slug or name), flagged rows first within a tenant. */
export function summarizeByTenant(rows) {
  const byTenant = new Map();
  for (const r of rows) {
    const key = r.tenantId ?? "(no tenant)";
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(r);
  }
  return [...byTenant.entries()].map(([tenantId, list]) => ({
    tenantId,
    lines: list.length,
    flagged: list.filter((r) => r.flagged).length,
    unitsRecordedDeltaPerCycle: list.reduce((s, r) => s + r.unitsRecordedDeltaPerCycle, 0),
    possibleOverbillPerCycle: roundMoney(list.reduce((s, r) => s + r.possibleOverbillPerCycle, 0)),
    rows: [...list].sort((a, b) => Number(b.flagged) - Number(a.flagged)),
  }));
}
