import { ConflictException } from "@nestjs/common";
import { CUSTOMER_DELETE_BLOCKING } from "../invoices/invoice-status-sets";

/**
 * #2558 / SA-510a: the guards that keep a customer delete from destroying an issued, paid or
 * written-off invoice (`CUSTOMER_DELETE_BLOCKING`, every status but DRAFT/VOID). Shared by
 * `CustomersService.batchDelete`, `deleteAllCustomers` and `deleteCustomer` (and, next,
 * `deleteImportedCustomers`, #2569). Three layers, because the pre-flight alone is a
 * time-of-check/time-of-use race (an invoice can be sent or paid between it and the delete):
 *   1. `assertNoBlockingInvoices`: the pre-flight OUTSIDE the transaction, the per-customer
 *      breakdown the operator sees (capped for a whole-tenant wipe).
 *   2. `readInvoicesAssertingNoneBlocking`: the same check INSIDE the transaction, on the read
 *      the delete then uses; any blocking invoice is a 409 and rolls back before any delete.
 *   3. `deleteNonBlockingInvoicesCas`: the invoice delete is a compare-and-set, scoped to the
 *      non-blocking statuses and required to remove exactly the rows it read, else 409. (Scoping
 *      alone is not enough: with no onDelete cascade, a leftover invoice would turn the
 *      customer delete into a raw FK error, a 500.)
 * `assertRecordFreeInTx` guards the single-customer hard-delete branch the same way.
 */
const MAX_LISTED_BLOCKERS = 10;
const BLOCKED =
  "Bulk delete blocked — the following customers have issued, paid or written-off invoices that cannot be destroyed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tenant client and the tx client both fit
type Db = any;

function blockedError(
  rows: Array<{ customerId: string; count: number }>,
  cap?: number,
): ConflictException {
  const listed = cap ? rows.slice(0, cap) : rows;
  const breakdown = listed.map((b) => `${b.customerId}: ${b.count} invoice(s)`);
  if (cap && rows.length > cap) breakdown.push(`and ${rows.length - cap} more`);
  return new ConflictException(`${BLOCKED}: ${breakdown.join("; ")}.`);
}

/** Layer 1: the pre-flight (outside the tx). `capList` caps the breakdown for a whole-tenant wipe. */
export async function assertNoBlockingInvoices(
  db: Db,
  customerIds: string[],
  opts: { capList?: boolean } = {},
): Promise<void> {
  const blockers: Array<{ customerId: string; _count: { _all: number } }> =
    await db.invoice.groupBy({
      by: ["customerId"],
      where: { customerId: { in: customerIds }, status: { in: CUSTOMER_DELETE_BLOCKING } },
      _count: { _all: true },
    });
  if (blockers.length > 0)
    throw blockedError(
      blockers.map((b) => ({ customerId: b.customerId, count: b._count._all })),
      opts.capList ? MAX_LISTED_BLOCKERS : undefined,
    );
}

/**
 * Layer 2: inside the tx, read the customers' invoices WITH their status; any blocking invoice is
 * a 409 (the pre-flight's message shape) before anything is deleted. Returns the ids to delete.
 */
export async function readInvoicesAssertingNoneBlocking(
  tx: Db,
  customerIds: string[],
): Promise<Array<{ id: string }>> {
  const invoices: Array<{ id: string; customerId: string; status: string }> =
    await tx.invoice.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true, customerId: true, status: true },
    });
  const counts = new Map<string, number>();
  for (const inv of invoices)
    if ((CUSTOMER_DELETE_BLOCKING as string[]).includes(inv.status))
      counts.set(inv.customerId, (counts.get(inv.customerId) ?? 0) + 1);
  if (counts.size > 0)
    throw blockedError(
      [...counts].map(([customerId, count]) => ({ customerId, count })),
      MAX_LISTED_BLOCKERS,
    );
  return invoices.map((i) => ({ id: i.id }));
}

/**
 * Layer 3: the invoice delete as a compare-and-set: only non-blocking statuses, and exactly the
 * `expected` rows the in-tx read returned; anything else changed underneath us and is a 409.
 */
export async function deleteNonBlockingInvoicesCas(
  tx: Db,
  customerIds: string[],
  expected: number,
): Promise<void> {
  const res = await tx.invoice.deleteMany({
    where: { customerId: { in: customerIds }, status: { notIn: CUSTOMER_DELETE_BLOCKING } },
  });
  if (res.count !== expected)
    throw new ConflictException(
      "Customer invoices changed while they were being deleted — nothing was deleted; please retry.",
    );
}

/**
 * The single-customer hard-delete branch runs only for a customer the pre-flight counted as
 * record-free; inside the tx it refuses (409, rollback) if ANY invoice or invoice payment exists
 * now, rather than destroying one created in between.
 */
export async function assertRecordFreeInTx(tx: Db, customerId: string): Promise<void> {
  const [invoices, payments] = await Promise.all([
    tx.invoice.count({ where: { customerId } }),
    tx.invoicePayment.count({ where: { invoice: { customerId } } }),
  ]);
  if (invoices + payments > 0)
    throw new ConflictException(
      "This customer gained invoices or payments while being deleted — nothing was deleted; please retry.",
    );
}
