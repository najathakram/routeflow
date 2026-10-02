import { ConflictException } from "@nestjs/common";
import { CUSTOMER_DELETE_BLOCKING } from "../invoices/invoice-status-sets";

/**
 * #2558 / SA-510a: the guards that keep a customer delete from destroying an issued, paid or
 * written-off or VOID invoice (`CUSTOMER_DELETE_BLOCKING`, every status but DRAFT). Shared by
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
 *
 * #2587 / SA-516: credit notes (any status), transaction payments, advance payments and invoice
 * payments are never destroyed by a customer delete. `assertNoMoneyRecords` (pre-flight) and
 * `assertNoMoneyRecordsInTx` (the in-tx re-check) refuse with a 409 naming the customers, and the
 * delete paths remove those tables only through `deleteMoneyRecordCas`, which expects ZERO rows.
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

const MONEY_BLOCKED =
  "Delete blocked — the following customers hold credit notes, payments or advance payments that cannot be destroyed";

/** Per-customer count of money records (#2587 / SA-516): credit notes of any status, transaction payments, advance payments, invoice payments. */
export async function countMoneyRecords(
  db: Db,
  customerIds: string[],
): Promise<Array<{ customerId: string; count: number }>> {
  const inIds = { customerId: { in: customerIds } };
  // #2597: aggregate in SQL. Never read every money row just to learn whose it is: on
  // deleteAllCustomers the customer set is the whole tenant.
  const byCustomer = { by: ["customerId"], where: inIds, _count: { _all: true } };
  const [notes, advances, perTxn, perInvoice] = await Promise.all([
    db.creditNote.groupBy(byCustomer),
    db.advancePayment.groupBy(byCustomer),
    db.payment.groupBy({
      by: ["transactionId"],
      where: { transaction: inIds },
      _count: { _all: true },
    }),
    db.invoicePayment.groupBy({
      by: ["invoiceId"],
      where: { invoice: inIds },
      _count: { _all: true },
    }),
  ]);
  const counts = new Map<string, number>();
  const add = (id: string, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);
  for (const r of [...notes, ...advances] as Array<{
    customerId: string;
    _count: { _all: number };
  }>)
    add(r.customerId, r._count._all);
  // Payments are owned through their parent: read the owners of just the parents that have any.
  const viaParent = async (
    parent: { findMany(args: unknown): Promise<Array<{ id: string; customerId: string }>> },
    groups: Array<Record<string, unknown> & { _count: { _all: number } }>,
    key: string,
  ) => {
    if (groups.length === 0) return;
    const n = new Map(groups.map((g) => [String(g[key]), g._count._all]));
    const owners = await parent.findMany({
      where: { id: { in: [...n.keys()] } },
      select: { id: true, customerId: true },
    });
    for (const o of owners) add(o.customerId, n.get(o.id) ?? 0);
  };
  await viaParent(db.transaction, perTxn, "transactionId");
  await viaParent(db.invoice, perInvoice, "invoiceId");
  return [...counts].map(([customerId, count]) => ({ customerId, count }));
}

function moneyBlockedError(rows: Array<{ customerId: string; count: number }>): ConflictException {
  const listed = rows
    .slice(0, MAX_LISTED_BLOCKERS)
    .map((b) => `${b.customerId}: ${b.count} record(s)`);
  if (rows.length > MAX_LISTED_BLOCKERS)
    listed.push(`and ${rows.length - MAX_LISTED_BLOCKERS} more`);
  return new ConflictException(`${MONEY_BLOCKED}: ${listed.join("; ")}.`);
}

/** #2587 pre-flight (outside the tx): any money record for any of the customers is a 409. */
export async function assertNoMoneyRecords(db: Db, customerIds: string[]): Promise<void> {
  const rows = await countMoneyRecords(db, customerIds);
  if (rows.length > 0) throw moneyBlockedError(rows);
}

/** #2587 in-tx twin: the same check on the transaction, before anything is deleted. */
export async function assertNoMoneyRecordsInTx(tx: Db, customerIds: string[]): Promise<void> {
  await assertNoMoneyRecords(tx, customerIds);
}

/**
 * #2587 (and #2591, delivery history): a protected table is only ever "deleted" as a compare-and-set expecting ZERO rows, so
 * a row that appeared after the re-check is a 409 and a rollback, never destroyed.
 */
export async function deleteMoneyRecordCas(
  delegate: { deleteMany(args: unknown): Promise<{ count: number }> },
  where: unknown,
): Promise<void> {
  const res = await delegate.deleteMany({ where });
  if (res.count !== 0)
    throw new ConflictException(
      "Customer records that block a delete appeared while deleting — nothing was deleted; please retry.",
    );
}

/**
 * #2591 / SA-516b: a customer with delivery history (ANY RouteRunStop, its own or one on one of
 * its RouteStops) is never hard-deleted — the history is refused, never destroyed (deleting the
 * RouteStop under a RouteRunStop was an FK 500). History-free route template rows stay deletable.
 */
function deliveryHistoryWhere(customerIds: string[]) {
  return {
    OR: [{ customerId: { in: customerIds } }, { routeStop: { customerId: { in: customerIds } } }],
  };
}

export async function countDeliveryHistory(db: Db, customerIds: string[]): Promise<string[]> {
  // #2597: owners only, aggregated in SQL (the stops' own customer, and the owners of RouteStops
  // that have runs) rather than every RouteRunStop row.
  const [own, viaStops]: [
    Array<{ customerId: string | null }>,
    Array<{ customerId: string | null }>,
  ] = await Promise.all([
    db.routeRunStop.groupBy({ by: ["customerId"], where: { customerId: { in: customerIds } } }),
    db.routeStop.findMany({
      where: { customerId: { in: customerIds }, routeRunStops: { some: {} } },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
  ]);
  const owners = new Set<string>();
  for (const r of [...own, ...viaStops])
    if (r.customerId && customerIds.includes(r.customerId)) owners.add(r.customerId);
  return [...owners];
}

/** Pre-flight (and, called with the tx, its in-tx twin): any delivery history is a 409. */
export async function assertNoDeliveryHistory(db: Db, customerIds: string[]): Promise<void> {
  const owners = await countDeliveryHistory(db, customerIds);
  if (owners.length > 0) {
    const listed = owners.slice(0, MAX_LISTED_BLOCKERS);
    if (owners.length > MAX_LISTED_BLOCKERS)
      listed.push(`and ${owners.length - MAX_LISTED_BLOCKERS} more`);
    throw new ConflictException(
      `Delete blocked — the following customers have delivery history that cannot be destroyed: ${listed.join("; ")}.`,
    );
  }
}

/** The RouteRunStop delete as a compare-and-set expecting ZERO rows. */
export async function deleteDeliveryHistoryCas(tx: Db, customerIds: string[]): Promise<void> {
  await deleteMoneyRecordCas(tx.routeRunStop, deliveryHistoryWhere(customerIds));
}

/**
 * #2572: the guards above re-check what the delete READS, but a row INSERTed for a customer after
 * those reads (a concurrent invoice create, say) is neither read nor deleted, so the customer-row
 * delete itself fails on the foreign key: a raw Prisma P2003, which reached the client as a 500.
 * Wrap ONLY the customer-row delete: a P2003 there is a 409 (the transaction still rolls back,
 * nothing is deleted); any other error, including an FK error from any other statement, is
 * rethrown unchanged.
 */
export async function deleteCustomerRowsFkRaceAs409<T>(del: Promise<T>): Promise<T> {
  try {
    return await del;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "P2003")
      throw new ConflictException(
        "Customer records changed while deleting — nothing was deleted; please retry.",
      );
    throw e;
  }
}
