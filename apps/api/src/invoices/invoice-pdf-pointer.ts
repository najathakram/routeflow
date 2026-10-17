/**
 * Row 502 (H4 follow-up): `Invoice.pdfUrl` is a CACHE POINTER to the rendered PDF, not invoice content. A Prisma
 * `update` moves the `@updatedAt` column, which is the edit token (`expectedUpdatedAt`, 409 INVOICE_STALE): so
 * rendering or invalidating a PDF while someone has the edit form open made their next save a false 409.
 * These are the only pointer-only writes; they go through tenant-scoped raw UPDATEs that leave `updatedAt`
 * alone. A write that changes invoice content AND nulls the pointer stays a normal update (it is an edit).
 */
type RawDb = { $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> };

/** Points one invoice at its rendered PDF key. */
export function writeInvoicePdfPointer(
  db: RawDb,
  tenantId: string,
  invoiceId: string,
  key: string,
): Promise<number> {
  return db.$executeRaw`UPDATE "Invoice" SET "pdfUrl" = ${key} WHERE id = ${invoiceId} AND "tenantId" = ${tenantId}`;
}

/** Drops every cached PDF pointer of one tenant (a tenant-level change that shows on the PDF). */
export function clearTenantInvoicePdfPointers(db: RawDb, tenantId: string): Promise<number> {
  return db.$executeRaw`UPDATE "Invoice" SET "pdfUrl" = NULL WHERE "tenantId" = ${tenantId} AND "pdfUrl" IS NOT NULL`;
}
