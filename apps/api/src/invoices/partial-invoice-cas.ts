import { BadRequestException, ConflictException } from "@nestjs/common";

/**
 * #2070 / SA-523: partial invoices must never over-bill an order line.
 *
 * `createPartialFromOrder` validates each requested qty against `qty − invoicedQty` from a read made
 * BEFORE its transaction, and used to bump `invoicedQty` unconditionally inside it. Two operators
 * billing the last 96 pieces of a line at the same moment both passed the check, both invoices were
 * created, and the line ended at 192 invoiced on a 96-piece line.
 *
 * Now each line's bump is a compare-and-set on EXACTLY what was read (`invoicedQty`, `qty`, and the
 * line still not CANCELLED): if anything changed in between, it matches 0 rows, and the whole
 * partial (the invoice included) rolls back with a 409. Matching the read `invoicedQty` also keeps
 * the proration basis (`priorBilledQty`) the invoice lines were built from valid. No lock.
 */

type PartialRequestItem = { orderItemId: string; qty: number };

/** Before the transaction: every requested line at most once, and a positive qty (SA-523). */
export function assertPartialRequestShape(items: PartialRequestItem[]): void {
  const seen = new Set<string>();
  for (const req of items) {
    if (seen.has(req.orderItemId))
      throw new BadRequestException(
        `Order item ${req.orderItemId} appears more than once in this partial invoice`,
      );
    seen.add(req.orderItemId);
    if (!(Number(req.qty) > 0))
      throw new BadRequestException(
        `Requested qty for order item ${req.orderItemId} must be greater than 0`,
      );
  }
}

/**
 * Inside the transaction: one CAS per line on the values read before it. `itemById` is the pre-tx
 * read the qty check and the invoice lines were built from. Any miss throws a 409 (rollback).
 */
export async function bumpInvoicedQtyCas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenantTransaction client
  tx: any,
  items: PartialRequestItem[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the order's line rows as read
  itemById: Map<string, any>,
): Promise<void> {
  for (const req of items) {
    const li = itemById.get(req.orderItemId);
    const readInvoicedQty = li?.invoicedQty;
    const readQty = li?.qty;
    // SA-511c: an `undefined` key in a Prisma `where` is silently DROPPED, turning the CAS into an
    // unconditional update. Refuse to write with a missing where-value.
    if (req.orderItemId == null || readInvoicedQty == null || readQty == null)
      throw new Error(
        `#2070: partial-invoice CAS where-value missing for order item ${String(req.orderItemId)}`,
      );
    const res = await tx.orderItem.updateMany({
      where: {
        id: req.orderItemId,
        invoicedQty: readInvoicedQty,
        qty: readQty,
        status: { not: "CANCELLED" },
      },
      data: { invoicedQty: { increment: req.qty } },
    });
    if (res.count !== 1)
      throw new ConflictException(
        "An order line changed while this partial invoice was being created — nothing was billed; please retry.",
      );
  }
}
