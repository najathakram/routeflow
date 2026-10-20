import type { Prisma } from "@prisma/client";

/**
 * Row-lock vendor bills for the rest of the caller's transaction, in SORTED id order so two
 * writers touching overlapping sets can't deadlock. B285: every writer of a bill's money or
 * receipt state (payments, void, delete, receive, statement apply, bulk mark-paid) must take
 * this BEFORE it reads the bill or its payments, or it plans from a stale read and overwrites a
 * concurrent writer (lost totalPaid, a payment on a voided bill, stock left behind a deleted bill).
 * Scoped to the tenant so a foreign id can't hold a lock before the tenant-scoped read 404s.
 */
export async function lockBillRows(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  ids: Iterable<string>,
): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  // Fail closed: `"tenantId" = NULL` matches no row, so a missing tenant would lock NOTHING and
  // the caller would carry on believing it holds the lock.
  if (!tenantId) throw new Error("lockBillRows needs a tenant: refusing to lock nothing");
  for (const id of unique) {
    await tx.$executeRaw`SELECT id FROM "VendorBill" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  }
}

/**
 * B291: row-lock supplier credits for the rest of the caller's transaction. Drawing a credit
 * (create / edit auto-apply) and handing a draw back (void / delete / edit refund) read a credit's
 * balance and then write it, so two bills on one supplier both read the same balance and both
 * drew it. Take this AFTER the bill lock and BEFORE reading any credit. One statement, ORDER BY
 * "receivedAt", id: every writer locks overlapping credits in the same order, so two of them
 * cannot deadlock; call it once with every supplier/credit the transaction will touch. The tenant
 * predicate is required on the raw statement (the tenant extension does not rewrite raw SQL), and
 * a missing tenant fails closed: `"tenantId" = NULL` matches nothing, which would lock nothing.
 */
export async function lockSupplierCredits(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  scope: { supplierIds?: Iterable<string | null | undefined>; creditIds?: Iterable<string> },
): Promise<void> {
  const supplierIds = [...new Set([...(scope.supplierIds ?? [])].filter((s): s is string => !!s))];
  const creditIds = [...new Set(scope.creditIds ?? [])];
  if (supplierIds.length === 0 && creditIds.length === 0) return;
  if (!tenantId) {
    throw new Error("lockSupplierCredits needs a tenant: refusing to lock nothing");
  }
  await tx.$executeRaw`SELECT id FROM "SupplierCredit" WHERE "tenantId" = ${tenantId} AND ("supplierId" = ANY(${supplierIds}::text[]) OR id = ANY(${creditIds}::text[])) ORDER BY "receivedAt", id FOR UPDATE`;
}
