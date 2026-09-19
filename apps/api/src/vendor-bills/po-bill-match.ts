import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * The bill-vs-PO HARD gate (units/PO step 7).
 *
 * A vendor bill linked to a purchase order may not bill more than the PO
 * authorised: per product, the billed PIECES may not exceed the PO's ordered
 * pieces, and no billed per-piece cost may exceed the PO's per-piece cost. The
 * industry default (Odoo) only warns and lets the bill through; RouteFlow blocks
 * it, because the linked bill is money-only (the PO moves the stock) — an
 * over-billed line would be paid for goods the PO never asked for.
 *
 * One bill per PO (`VendorBill.purchaseOrderId` is unique), so "remaining" is the
 * whole ordered quantity. Three-way match against goods receipts is deferred.
 *
 * Bill lines arrive already converted to the PO's denomination — pieces and a
 * per-piece cost, via VendorBillsService.lineInventoryDelta — so a case-priced
 * line (packSize > 1) compares like for like. Unmapped lines (no productId) move
 * no stock and can't be matched to a PO line; they are not gated here.
 */

/** Per-piece costs are stored to 4dp; anything within rounding of the PO cost is not an overrun. */
export const PO_PRICE_EPSILON = new Prisma.Decimal("0.0001");

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

export type PoMatchReason = "NOT_ON_PO" | "QTY_EXCEEDS_PO" | "PRICE_EXCEEDS_PO";

export interface PoMatchViolation {
  reason: PoMatchReason;
  productId: string;
  description: string;
  /** What the bill carries (pieces for QTY, per-piece cost for PRICE). */
  billed: string;
  /** What the PO allows. Empty for NOT_ON_PO. */
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
  for (const i of poItems) {
    ordered.set(i.productId, (ordered.get(i.productId) ?? D(0)).add(D(i.qtyOrdered)));
    const cost = D(i.unitCost);
    const seen = maxCost.get(i.productId);
    if (!seen || cost.gt(seen)) maxCost.set(i.productId, cost);
  }

  const violations: PoMatchViolation[] = [];
  const billedQty = new Map<string, Prisma.Decimal>();
  const firstDescription = new Map<string, string>();

  for (const line of billLines) {
    if (!line.productId) continue; // unmapped: nothing to match against
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
    billedQty.set(line.productId, (billedQty.get(line.productId) ?? D(0)).add(D(line.qty)));
    if (!firstDescription.has(line.productId))
      firstDescription.set(line.productId, line.description);

    const allowedCost = maxCost.get(line.productId)!;
    if (D(line.unitCost).gt(allowedCost.add(PO_PRICE_EPSILON))) {
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
      if (v.reason === "NOT_ON_PO") return `"${v.description}" is not on ${poNumber}`;
      if (v.reason === "QTY_EXCEEDS_PO")
        return `"${v.description}": billed ${v.billed} pcs, ${poNumber} allows ${v.allowed}`;
      return `"${v.description}": billed at ${v.billed} per piece, ${poNumber} allows ${v.allowed}`;
    })
    .join("; ");
  throw new ConflictException({
    code: "BILL_EXCEEDS_PO",
    message:
      `This bill is more than purchase order ${poNumber} authorised — ${detail}. ` +
      "Edit the purchase order to match the invoice first (or correct the bill), then try again.",
    poNumber,
    violations,
  });
}
