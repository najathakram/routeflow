/**
 * B646 / SA-135a — pure classification behind report-recurring-boxed-template-qty.mjs (no I/O).
 *
 * A recurring template line for a BOXED product (unitsPerBox > 1, no selling-unit label) has always
 * been BILLED as `qty x unitPrice` with `unitPrice` the per-box price, i.e. qty counted BOXES. Until the
 * B646 fix, the generated invoice line was STORED with that same qty in the pieces column, so stock
 * moved `qty` PIECES per cycle. After the fix it is stored as `qty x unitsPerBox` pieces.
 *
 * So for each such line this reports two things, neither of which changes the bill going forward:
 *   (i)  possible PAST over-billing: a template whose qty looks like PIECES (qty > unitsPerBox, or not
 *        an integer) was billed qty x per-box price every cycle, unitsPerBox times a pieces-intent figure;
 *   (ii) the FUTURE stock change the fix introduces: pieces decremented per cycle today vs after the fix.
 *        A pieces-intent template must be corrected (qty / unitsPerBox) BEFORE the fix's first cycle.
 */
import { roundMoney } from "@routeflow/pricing";

/**
 * @param {{ productId: string|null, qty: unknown, unitPrice: unknown, unitLabel?: string|null,
 *           unitsPerBox?: number|null }} line
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

  const reasons = [];
  if (qty > pack) reasons.push("qty>unitsPerBox");
  if (!Number.isInteger(qty)) reasons.push("non-integer");

  const currentDecrementPieces = qty; // pre-fix: qty stored in the pieces column
  const postFixDecrementPieces = splits ? wholeBoxes * pack + loosePieces : qty;
  const billedPerCycle = roundMoney(qty * unitPrice);
  const billedIfPiecesIntent = roundMoney((qty / pack) * unitPrice);
  return {
    unitsPerBox: pack,
    qty,
    unitPrice,
    flagged: reasons.length > 0,
    reasons,
    splits,
    currentDecrementPieces,
    postFixDecrementPieces,
    stockDeltaPerCycle: postFixDecrementPieces - currentDecrementPieces,
    billedPerCycle,
    billedIfPiecesIntent,
    possibleOverbillPerCycle: reasons.includes("qty>unitsPerBox")
      ? roundMoney(billedPerCycle - billedIfPiecesIntent)
      : 0,
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
    stockDeltaPerCycle: list.reduce((s, r) => s + r.stockDeltaPerCycle, 0),
    possibleOverbillPerCycle: roundMoney(list.reduce((s, r) => s + r.possibleOverbillPerCycle, 0)),
    rows: [...list].sort((a, b) => Number(b.flagged) - Number(a.flagged)),
  }));
}
