/**
 * SA-674b: while its order is with the carrier (`carrierCancelBlockedReason`), an order's SHIPMENT invoice
 * refuses line and quantity changes (add / remove / qty / product). Price, discount and notes stay
 * editable. Why: a cut on the shipment invoice only syncs the order lines' `invoicedQty`, so at DELIVERED
 * the remainder create bills the cut again as a second invoice; and an invoice-side line change moves no
 * stock. The order-side twin is `ORDER_WITH_CARRIER_NO_REDUCE` (settleStockForEdit).
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { carrierBlocked } from "../orders/order-carrier-guard";
import type { PrismaService } from "../prisma/prisma.service";
import type { EditPayloadLine, LineMatch, StoredEditRow } from "./invoice-edit-plan";

/** True when the invoice's order is with the carrier now (one order read; none without an order). */
export async function invoiceOrderWithCarrier(
  deps: Parameters<typeof carrierBlocked>[0] & { prisma: Pick<PrismaService, "forTenant"> },
  orderId: string | null | undefined,
): Promise<boolean> {
  if (!orderId) return false;
  const order = await deps.prisma.forTenant().order.findFirst({
    where: { id: orderId },
    select: { id: true, tenantId: true, status: true, fulfillPath: true, shippedAt: true },
  });
  return !!order && (await carrierBlocked(deps, order)) !== null;
}

const same = (a: unknown, b: unknown) =>
  a == null || b == null ? a == null && b == null : Math.abs(Number(a) - Number(b)) < 1e-9;

/** What the edit changes on the lines themselves (not their money), or null when it changes none. */
export function carrierLineChange(
  items: EditPayloadLine[],
  matches: LineMatch[],
  stored: StoredEditRow[],
): string | null {
  if (matches.some((m) => !m.row)) return "adds a line";
  if (matches.some((m) => m.productChanged)) return "changes a line's product";
  const kept = new Set(matches.map((m) => m.row!.id));
  if (stored.some((r) => !kept.has(r.id))) return "removes a line";
  const qtyChanged = items.some((it, i) => {
    const row = matches[i].row!;
    return !same(it.qty, row.qty) || !same(it.boxes, row.boxes) || !same(it.pieces, row.pieces);
  });
  return qtyChanged ? "changes a quantity" : null;
}

/** The coded 409, thrown before any write. */
export function assertCarrierLinesUnchanged(
  items: EditPayloadLine[],
  matches: LineMatch[],
  stored: StoredEditRow[],
): void {
  const change = carrierLineChange(items, matches, stored);
  if (!change) return;
  throw new ConflictException({
    code: API_ERROR_CODES.INVOICE_WITH_CARRIER_NO_LINE_CHANGE,
    message:
      `This order is already with the carrier, so its invoice can't be changed this way (it ${change}). ` +
      "Price, discount and notes can still be edited; record a return for goods that come back.",
  });
}
