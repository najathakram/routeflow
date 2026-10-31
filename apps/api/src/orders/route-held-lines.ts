import {
  deliveredBasisByLine,
  deliveredQtyFromBasis,
  isEvidenceRow,
} from "../invoices/delivered-basis-by-line";

const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** One line that keeps the driver's figure on a DELIVERED order (named in the status response). */
export interface RouteHeldLine {
  lineId: string;
  delivered: number;
  qty: number;
}

/**
 * Row 590 (SA-978 §1): the lines an office DELIVERED leaves at the driver's figure. A line with any qualifying route-stop
 * DeliveryMutation row keeps its route figure (SA-814 R4-3; the route writers recompute the column from those rows), so the
 * office stamp and `completeOfficeEvidencedLines` skip it. Its invoice bills `min(qty, Σ evidence)` and stock books
 * `max(qty, delivered)` until the office cuts the quantity or records a Return (B1050): this names the lines so the
 * response says so. READ ONLY: it writes nothing, never raises a figure (OP-6), and runs in the status transaction on the
 * same `deliveredBasisByLine` basis the invoice reads. `delivered` is the rows' sum (rows beat the column), capped at qty.
 */
export async function routeHeldLines(tx: any, orderId: string): Promise<RouteHeldLine[]> {
  const routeRows: Array<{ orderItemId: string | null; type: string; quantityDelivered: unknown }> =
    await tx.deliveryMutation.findMany({
      where: { orderId, routeRunStopId: { not: null } },
      select: { orderItemId: true, type: true, quantityDelivered: true },
    });
  const routeLineIds = new Set(
    routeRows.filter(isEvidenceRow).flatMap((m) => (m.orderItemId ? [m.orderItemId] : [])),
  );
  if (routeLineIds.size === 0) return [];
  const lines: Array<{ id: string; qty: unknown; deliveredQty: unknown }> =
    await tx.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: { id: true, qty: true, deliveredQty: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
  const basis = await deliveredBasisByLine(tx, orderId);
  const held: RouteHeldLine[] = [];
  for (const li of lines) {
    if (!routeLineIds.has(li.id)) continue;
    const delivered = r3(deliveredQtyFromBasis(li, basis));
    const qty = Number(li.qty);
    if (delivered < qty - EPS) held.push({ lineId: li.id, delivered, qty });
  }
  return held;
}
