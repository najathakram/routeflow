/**
 * Row 587 (SA-814h item 4, P1; SA-833 §1): PARTIALLY_DELIVERED -> DELIVERED completes the lines the OFFICE marked
 * partly delivered.
 *
 * An office PD (order-pd-quantities.ts) records its per-line quantities as DeliveryMutation evidence rows with
 * NO route stop and NO driver, and the delivered-basis invoice bills `min(qty, Σ evidence)`. The "entry" stamp
 * (delivered-stamp.ts) skips every evidenced line, so a 6-of-10 line stayed at 6 on a DELIVERED order. A
 * DELIVERED write says the rest left too: this writes ONE office DELIVERED row for the remainder (rows beat the
 * column), lifts `deliveredQty` to qty, and writes one AuditLog row per completed line ("line X: 6 -> 10, office
 * completion"), all in the caller's transaction. It returns the completed lines so the status response can name them.
 *
 * Only OFFICE-evidenced lines: every qualifying row of the line has no route stop, no driver, and a DELIVERED or
 * PARTIAL type. Every route writer (routes.service.ts completeStop / completeWithPayment) always sets
 * `routeRunStopId`, so a null stop IS the office origin; the free-text note is never part of the test. A line with any route-stop row keeps its route figure (SA-814 R4-3 note: a separate row), a
 * REFUSED row is a resolved outcome, never a partial figure, a CANCELLED line is not delivered at all, and an order
 * that rode a route stop is never touched (as the stamp). Idempotent: a completed line has no remainder.
 * The only "closed short" exit stays DELIVERED -> CONFIRMED with its required reason (SA-814h #1).
 */
import { isEvidenceRow } from "../invoices/delivered-basis-by-line";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const OFFICE_ROW_TYPES: readonly string[] = ["DELIVERED", "PARTIAL"];
export const OFFICE_MARKED_NOTE = "OFFICE_MARKED";
/** Who wrote the DELIVERED status, for the audit rows. */
export interface OfficeCompletionActor {
  tenantId: string | null;
  userId?: string | null;
  impersonatedBy?: string | null;
}

/** One line completed from the office's partial figure to its full qty. */
export interface OfficeCompletedLine {
  lineId: string;
  from: number;
  to: number;
  /** The audit wording: "line X: 6 -> 10, office completion". */
  summary: string;
}

export async function completeOfficeEvidencedLines(
  tx: any,
  orderId: string,
  actor: OfficeCompletionActor,
): Promise<OfficeCompletedLine[]> {
  const head: { routeRunStopId: string | null } | null = await tx.order.findFirst({
    where: { id: orderId },
    select: { routeRunStopId: true },
  });
  if (!head || head.routeRunStopId) return []; // gone, or a legacy route delivery: its columns stay
  const lines: Array<{
    id: string;
    productId: string | null;
    qty: unknown;
    deliveredQty: unknown;
  }> = await tx.orderItem.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: { id: true, productId: true, qty: true, deliveredQty: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const rows: Array<{
    orderItemId: string | null;
    type: string;
    quantityDelivered: unknown;
    routeRunStopId?: string | null;
    driverId?: string | null;
  }> = await tx.deliveryMutation.findMany({
    where: { orderId },
    select: {
      orderItemId: true,
      type: true,
      quantityDelivered: true,
      routeRunStopId: true,
      driverId: true,
    },
  });
  const byLine = new Map<string, { sum: number; office: boolean }>();
  for (const m of rows.filter(isEvidenceRow)) {
    if (!m.orderItemId) continue;
    const e = byLine.get(m.orderItemId) ?? { sum: 0, office: true };
    e.sum = r3(e.sum + (m.type === "REFUSED" ? 0 : Number(m.quantityDelivered)));
    if (m.routeRunStopId != null || m.driverId != null || !OFFICE_ROW_TYPES.includes(m.type)) {
      e.office = false;
    }
    byLine.set(m.orderItemId, e);
  }
  const completed: OfficeCompletedLine[] = [];
  for (const li of lines) {
    const e = byLine.get(li.id);
    if (!e?.office) continue;
    const remainder = r3(Number(li.qty) - e.sum);
    if (remainder <= EPS) continue;
    const to = r3(e.sum + remainder);
    const summary = `line ${li.id}: ${e.sum} -> ${to}, office completion`;
    await tx.deliveryMutation.create({
      data: {
        orderId,
        orderItemId: li.id,
        productId: li.productId ?? null,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: remainder,
        note: OFFICE_MARKED_NOTE,
      },
    });
    await tx.orderItem.update({
      where: { id: li.id },
      data: { deliveredQty: Math.max(Number(li.deliveredQty), to) },
    });
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId ?? null,
        impersonatedBy: actor.impersonatedBy ?? null,
        action: AUDIT_ACTIONS.ORDER_LINE_OFFICE_COMPLETED,
        entityType: "Order",
        entityId: orderId,
        meta: { orderId, lineId: li.id, from: e.sum, to, summary },
      },
    });
    completed.push({ lineId: li.id, from: e.sum, to, summary });
  }
  return completed;
}
