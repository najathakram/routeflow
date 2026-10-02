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
