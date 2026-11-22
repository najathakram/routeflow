import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * The bill-vs-PO HARD gate (units/PO step 7).
 *
 * A vendor bill linked to a purchase order may not bill more than the PO
 * authorised. The industry default (Odoo) only warns and lets the bill through;
 * RouteFlow blocks it, because the linked bill is money-only (the PO moves the
 * stock) — an over-billed line would be paid for goods the PO never asked for.
 * Checked, per bill:
 *   - every line is a product on the PO (an unmapped line — freight, a deposit, a
 *     mistyped item — carries money the PO never authorised, so a linked bill
 *     can't have one; charges like that belong on their own bill);
 *   - per product, billed PIECES <= ordered pieces;
 *   - per line, the billed value <= the larger of the PO line's two stored figures
 *     for the billed pieces (pieces x `unitCost`, or `totalCost` x pieces / ordered),
 *     give or take a cent of entry rounding (a PO hand-raised at 3.33 a piece still
 *     accepts a 3-pack billed at 10.00);
 *   - overall, the billed value <= the larger of the PO's two sums (so a mixed-cost
 *     PO can't have its cheap lines billed at its dear price).
 *
 * One bill per PO (`VendorBill.purchaseOrderId` is unique), so "remaining" is the
 * whole ordered quantity. Three-way match against goods receipts is deferred.
 * Tax is not compared here: the PO carries no tax to compare against.
 *
 * Check X (SA-1207 P2a): QTY is judged in pieces, but line MONEY is judged in the
 * line's OWN unit (`ownQty` x `ownUnitCost`: boxes, a lot of 1, or pieces), never
 * re-derived through a 4-decimal piece cost: 122 pieces at 0.2084 is not the 25.42
 * the PO stores. No stored figure changes, and R-005 stays a hard 409.
 *
 * Bill lines arrive converted to pieces, via VendorBillsService.lineInventoryDelta,
 * and carry the line as billed in `ownQty` / `ownUnitCost`.
 */

/** Tolerance for entry rounding, per bill line, in money. */
export const PO_LINE_TOLERANCE = new Prisma.Decimal("0.01");

export interface PoLineLike {
  productId: string;
  qtyOrdered: Prisma.Decimal | number | string;
  unitCost: Prisma.Decimal | number | string;
  /** The stored line total. Absent (old callers, specs) = pieces x `unitCost`. */
  totalCost?: Prisma.Decimal | number | string | null;
}

export interface BillLinePieces {
  productId: string | null;
  description: string;
  /** Pieces (already multiplied out by packSize). */
  qty: Prisma.Decimal | number | string;
  /** Per PIECE. */
  unitCost: Prisma.Decimal | number | string;
  /** The line AS BILLED, in its own unit (boxes, 1 lot, or pieces). Absent = a piece line (`qty` x `unitCost`). */
  ownQty?: Prisma.Decimal | number | string;
  ownUnitCost?: Prisma.Decimal | number | string;
}

export type PoMatchReason =
  "UNMAPPED_LINE" | "NOT_ON_PO" | "QTY_EXCEEDS_PO" | "PRICE_EXCEEDS_PO" | "TOTAL_EXCEEDS_PO";

export interface PoMatchViolation {
  reason: PoMatchReason;
  /** Empty for UNMAPPED_LINE and TOTAL_EXCEEDS_PO. */
  productId: string;
  description: string;
  /** What the bill carries: pieces (QTY), per-piece cost (PRICE), money (TOTAL). */
  billed: string;
  /** What the PO allows. Empty for UNMAPPED_LINE / NOT_ON_PO. */
  allowed: string;
}

const D = (n: Prisma.Decimal | number | string) => new Prisma.Decimal(n);

/**
 * Does ONE PO line allow `lineValue` for `pieces`? The larger of its two stored figures, plus a cent:
 * pieces x `unitCost`, or `totalCost` x pieces / ordered (compared cross-multiplied, so a cent that
 * lands exactly on the limit is never lost to a division).
 */
function lineWithinPoLine(
  p: PoLineLike,
  pieces: Prisma.Decimal,
  lineValue: Prisma.Decimal,
): boolean {
  const net = lineValue.sub(PO_LINE_TOLERANCE);
  if (net.lte(pieces.mul(D(p.unitCost)))) return true;
  const ordered = D(p.qtyOrdered);
  return p.totalCost != null && ordered.gt(0) && net.mul(ordered).lte(D(p.totalCost).mul(pieces));
}

/** The PO line's best per-piece rate, for the refusal message only. */
function bestPieceRate(p: PoLineLike): Prisma.Decimal {
  const unit = D(p.unitCost);
  const ordered = D(p.qtyOrdered);
  return p.totalCost != null && ordered.gt(0)
    ? Prisma.Decimal.max(unit, D(p.totalCost).div(ordered))
    : unit;
}

/** Pure: every way the bill's lines exceed the PO. Empty = the bill is within the PO. */
export function findPoMatchViolations(
  poItems: PoLineLike[],
  billLines: BillLinePieces[],
): PoMatchViolation[] {
  const ordered = new Map<string, Prisma.Decimal>();
  const poLines = new Map<string, PoLineLike[]>();
  let poValue = D(0);
  let poStored = D(0);
  for (const i of poItems) {
    ordered.set(i.productId, (ordered.get(i.productId) ?? D(0)).add(D(i.qtyOrdered)));
    poLines.set(i.productId, [...(poLines.get(i.productId) ?? []), i]);
    const pieceSum = D(i.qtyOrdered).mul(D(i.unitCost));
    poValue = poValue.add(pieceSum);
    poStored = poStored.add(i.totalCost != null ? D(i.totalCost) : pieceSum);
  }
  poValue = Prisma.Decimal.max(poValue, poStored);

  const violations: PoMatchViolation[] = [];
  const billedQty = new Map<string, Prisma.Decimal>();
  const firstDescription = new Map<string, string>();
  let billedValue = D(0);
  let tolerance = D(0);

  for (const line of billLines) {
    if (!line.productId) {
      violations.push({
        reason: "UNMAPPED_LINE",
        productId: "",
        description: line.description,
        billed: D(line.qty).mul(D(line.unitCost)).toString(),
        allowed: "",
      });
      continue;
    }
    if (!ordered.has(line.productId)) {
      violations.push({
        reason: "NOT_ON_PO",
        productId: line.productId,
        description: line.description,
        billed: D(line.qty).toString(),
        allowed: "",
      });
      continue;
    }
    const qty = D(line.qty);
    const lineValue =
      line.ownQty != null && line.ownUnitCost != null
        ? D(line.ownQty).mul(D(line.ownUnitCost))
        : qty.mul(D(line.unitCost));
    billedValue = billedValue.add(lineValue);
    tolerance = tolerance.add(PO_LINE_TOLERANCE);
    billedQty.set(line.productId, (billedQty.get(line.productId) ?? D(0)).add(qty));
    if (!firstDescription.has(line.productId))
      firstDescription.set(line.productId, line.description);

    const lines = poLines.get(line.productId)!;
    if (!lines.some((p) => lineWithinPoLine(p, qty, lineValue))) {
      const allowedCost = Prisma.Decimal.max(...lines.map(bestPieceRate));
      violations.push({
        reason: "PRICE_EXCEEDS_PO",
        productId: line.productId,
        description: line.description,
        billed: D(line.unitCost).toString(),
        allowed: allowedCost.toDecimalPlaces(4, Prisma.Decimal.ROUND_UP).toString(),
      });
    }
  }

  for (const [productId, qty] of billedQty) {
    const allowed = ordered.get(productId)!;
    if (qty.gt(allowed)) {
      violations.push({
        reason: "QTY_EXCEEDS_PO",
        productId,
        description: firstDescription.get(productId) ?? productId,
        billed: qty.toString(),
        allowed: allowed.toString(),
      });
    }
  }

  if (billedValue.gt(poValue.add(tolerance))) {
    violations.push({
      reason: "TOTAL_EXCEEDS_PO",
      productId: "",
      description: "the whole bill",
      billed: billedValue.toDecimalPlaces(2).toString(),
      allowed: poValue.toDecimalPlaces(2).toString(),
    });
  }
  return violations;
}

/** Throws the operator-facing 409 when the bill exceeds the PO; a no-op otherwise. */
export function assertBillWithinPo(
  poNumber: string,
  poItems: PoLineLike[],
  billLines: BillLinePieces[],
): void {
  const violations = findPoMatchViolations(poItems, billLines);
  if (violations.length === 0) return;
  const detail = violations
    .map((v) => {
      switch (v.reason) {
        case "UNMAPPED_LINE":
          return `"${v.description}" isn't linked to a product on ${poNumber} (freight and other charges belong on their own bill)`;
        case "NOT_ON_PO":
          return `"${v.description}" is not on ${poNumber}`;
        case "QTY_EXCEEDS_PO":
          return `"${v.description}": billed ${v.billed} pcs, ${poNumber} allows ${v.allowed}`;
        case "PRICE_EXCEEDS_PO":
          return `"${v.description}": billed at ${v.billed} per piece, ${poNumber} allows ${v.allowed}`;
        default:
          return `the bill totals ${v.billed}, ${poNumber} authorised ${v.allowed}`;
      }
    })
    .join("; ");
  throw new ConflictException({
    code: API_ERROR_CODES.BILL_EXCEEDS_PO,
    message:
      `This bill is more than purchase order ${poNumber} authorised — ${detail}. ` +
      "Edit the purchase order to match the invoice first (or correct the bill), then try again.",
    poNumber,
    violations,
  });
}
