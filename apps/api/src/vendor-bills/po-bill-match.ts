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
 *   - per line, the billed value <= the pieces at the PO's per-piece cost, give or
 *     take a cent of entry rounding (a PO hand-raised at 3.33 a piece still
 *     accepts a 3-pack billed at 10.00);
 *   - overall, the billed value <= the PO's value (so a mixed-cost PO can't have
 *     its cheap lines billed at its dear price).
 *
 * One bill per PO (`VendorBill.purchaseOrderId` is unique), so "remaining" is the
 * whole ordered quantity. Three-way match against goods receipts is deferred.
 * Tax is not compared here: the PO carries no tax to compare against.
 *
 * Bill lines arrive already converted to the PO's denomination — pieces and a
 * per-piece cost, via VendorBillsService.lineInventoryDelta — so a case-priced
 * line (packSize > 1) compares like for like.
 */

/** Tolerance for entry rounding, per bill line, in money. */
export const PO_LINE_TOLERANCE = new Prisma.Decimal("0.01");

export interface PoLineLike {
  productId: string;
  qtyOrdered: Prisma.Decimal | number | string;
  unitCost: Prisma.Decimal | number | string;
}

export interface BillLinePieces {
  productId: string | null;
  description: string;
  /** Pieces (already multiplied out by packSize). */
  qty: Prisma.Decimal | number | string;
  /** Per PIECE. */
  unitCost: Prisma.Decimal | number | string;
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

/** Pure: every way the bill's lines exceed the PO. Empty = the bill is within the PO. */
export function findPoMatchViolations(
  poItems: PoLineLike[],
  billLines: BillLinePieces[],
): PoMatchViolation[] {
  const ordered = new Map<string, Prisma.Decimal>();
  const maxCost = new Map<string, Prisma.Decimal>();
  let poValue = D(0);
  for (const i of poItems) {
    ordered.set(i.productId, (ordered.get(i.productId) ?? D(0)).add(D(i.qtyOrdered)));
    const cost = D(i.unitCost);
    const seen = maxCost.get(i.productId);
    if (!seen || cost.gt(seen)) maxCost.set(i.productId, cost);
    poValue = poValue.add(D(i.qtyOrdered).mul(cost));
  }

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
    const lineValue = qty.mul(D(line.unitCost));
    billedValue = billedValue.add(lineValue);
    tolerance = tolerance.add(PO_LINE_TOLERANCE);
    billedQty.set(line.productId, (billedQty.get(line.productId) ?? D(0)).add(qty));
    if (!firstDescription.has(line.productId))
      firstDescription.set(line.productId, line.description);

    const allowedCost = maxCost.get(line.productId)!;
    if (lineValue.gt(qty.mul(allowedCost).add(PO_LINE_TOLERANCE))) {
      violations.push({
        reason: "PRICE_EXCEEDS_PO",
        productId: line.productId,
        description: line.description,
        billed: D(line.unitCost).toString(),
        allowed: allowedCost.toString(),
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
