import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * The tenant-wide "units" advisory lock: ONE key per tenant that keeps a unit RENAME and every write
 * that changes what a rename checks from interleaving.
 *
 * A rename relabels levels across every product of the tenant and refuses when a new name would equal a
 * product's pack word or another level. A concurrent pack edit (`Product.unit`) or level write could
 * flip that answer between the check and the write and leave a level the ladder can never reach. So:
 *  - `UnitsService.rename` takes it EXCLUSIVE;
 *  - a pack edit (`ProductsService.update` when dto carries unit / unitsPerBox / the section), a
 *    level write and the import `completeSetup` take it SHARED (via `lockProductPack`), so they run side
 *    by side across products but never alongside a rename; ONE product's pack edit and level writes are
 *    serialized by the per-product lock `lockProductPack` takes right after it.
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

/** SQLSTATE 55P03 (lock_not_available), as pg, Prisma raw queries and the driver adapter report it. */
export function isLockTimeout(e: unknown): boolean {
  const x = e as {
    code?: string;
    message?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  } | null;
  return (
    x?.code === "55P03" ||
    x?.meta?.code === "55P03" ||
    x?.meta?.driverAdapterError?.cause?.originalCode === "55P03" ||
    /lock timeout/i.test(x?.message ?? "")
  );
}

/**
 * Run `acquire` under a bounded wait: `SET LOCAL lock_timeout` before it, back to the default right
 * after it, so the bound covers ONLY these locks and not later row or barcode locks of the same
 * transaction. A rename holds the tenant lock exclusive for up to 60 s; without a bound every product
 * save, level write and import confirmation of the tenant would queue behind it until Prisma's 5 s
 * transaction timeout turned them into 500s (and pinned pool connections). A timeout is a clean 409
 * the caller can retry. The two literals are separate statements because SET takes no bind value.
 */
async function bounded(
  tx: RawExecutor,
  wait: "3s" | "5s",
  acquire: () => PromiseLike<unknown>,
): Promise<void> {
  if (wait === "5s") await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  else await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
  try {
    await acquire();
  } catch (e) {
    if (isLockTimeout(e)) {
      throw new ConflictException({
        code: API_ERROR_CODES.UNITS_RENAME_IN_PROGRESS,
        message: "Another change is in progress. Try again in a moment.",
      });
    }
    throw e;
  }
  await tx.$executeRaw`SET LOCAL lock_timeout TO DEFAULT`;
}

const takeTenantLock = (tx: RawExecutor, tenantId: string, mode: "shared" | "exclusive") =>
  mode === "exclusive"
    ? tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TENANT_UNITS_LOCK_FAMILY}), hashtext(${tenantId}))`
    : tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${TENANT_UNITS_LOCK_FAMILY}), hashtext(${tenantId}))`;

/**
 * The shared lock waits at most 3 s for a rename (a 409 if it is still running); the rename's
 * exclusive lock waits at most 5 s for in-flight writers (each holds it for milliseconds).
 */
export async function lockTenantUnits(
  tx: RawExecutor,
  tenantId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  await bounded(tx, mode === "exclusive" ? "5s" : "3s", () => takeTenantLock(tx, tenantId, mode));
}

/**
 * What a writer of ONE product's pack or ladder takes, in this order: the tenant units lock SHARED
 * (so it waits for a rename), then that product's own `product-units` lock. The shared tenant lock lets
 * writers run side by side across products; the per-product lock is what serializes a level write
 * against a pack edit of the SAME product (each reads what the other writes). Used by every
 * `ProductUnitsService` mutation, `ProductsService.update` when the pack can change, and the import
 * `completeSetup`. Take it first in the transaction, before any other lock.
 */
export async function lockProductPack(
  tx: RawExecutor,
  tenantId: string,
  productId: string,
): Promise<void> {
  await bounded(tx, "3s", async () => {
    await takeTenantLock(tx, tenantId, "shared");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${productId}))`;
  });
}
