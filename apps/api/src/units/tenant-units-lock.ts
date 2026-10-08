/**
 * The tenant-wide "units" advisory lock: ONE key per tenant that keeps a unit RENAME and every write
 * that changes what a rename checks from interleaving.
 *
 * A rename relabels levels across every product of the tenant and refuses when a new name would equal a
 * product's pack word or another level. A concurrent pack edit (`Product.unit`) or level write could
 * flip that answer between the check and the write and leave a level the ladder can never reach. So:
 *  - `UnitsService.rename` takes it EXCLUSIVE;
 *  - a pack edit (`ProductsService.update` when the pack word, size or section moves) and every
 *    `ProductUnitsService` mutation take it SHARED, so they run side by side but never alongside a rename.
 * Transaction-scoped (`pg_advisory_xact_lock*`): released at commit or rollback, no pool slot, same
 * mechanism as `product-labels` / `product-units`. One lock instead of one per product: a rename can
 * touch thousands of products and a lock per product would exhaust the lock table.
 *
 * LOCK ORDER: take it FIRST in the transaction, before any other advisory lock (barcode, name,
 * product-units) and before any row lock. Every holder does, so none waits on it while holding
 * something a rename needs.
 */
export const TENANT_UNITS_LOCK_FAMILY = "tenant-units";

interface RawExecutor {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}

export async function lockTenantUnits(
  tx: RawExecutor,
  tenantId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  if (mode === "exclusive") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TENANT_UNITS_LOCK_FAMILY}), hashtext(${tenantId}))`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${TENANT_UNITS_LOCK_FAMILY}), hashtext(${tenantId}))`;
  }
}
