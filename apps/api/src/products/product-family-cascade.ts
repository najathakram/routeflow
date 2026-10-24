import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockProductRow, type CatalogTx } from "./product-catalog-sync";
import { peekProductCodes, releaseProductCodes } from "./product-code-release";

/**
 * B1213: a variant is only as live as its family.
 *
 *  - Deactivating a family that still has ACTIVE variants answers a coded 409 carrying the count
 *    (`FAMILY_HAS_ACTIVE_VARIANTS`) unless the caller confirmed (`confirmCascade`); a confirmed deactivation
 *    deactivates those variants in the SAME transaction, with the code-release rules of a single deactivate.
 *  - Reactivating a variant whose parent family is inactive is a coded 409 (`VARIANT_PARENT_INACTIVE`).
 *
 * Lock order (house order, product-catalog-sync.ts): the caller takes ONE sorted `lockBarcodeCodes` call that already
 * includes the variants' codes (`variantCodes`), then the family row (its own `releaseProductCodes`), then the
 * variant rows in id order (`cascadeDeactivate`).
 */

/** Ids of the family's ACTIVE variants (any `kind`: a variant is anything whose `parentProductId` is the family). */
export async function activeVariantIds(
  tx: CatalogTx,
  tenantId: string,
  familyId: string,
): Promise<string[]> {
  const rows: Array<{ id: string }> = await tx.product.findMany({
    where: { tenantId, parentProductId: familyId, isActive: true },
    select: { id: true },
  });
  return rows.map((r) => r.id).sort();
}

export function familyHasActiveVariants(variantCount: number): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS,
    message: `This product has ${variantCount} active variant${variantCount === 1 ? "" : "s"}. Deactivating it deactivates them too; confirm to continue.`,
    variantCount,
  });
}

/** Every live and retired code of the given products (unlocked pre-peek): input for the caller's one sorted lock call. */
export async function variantCodes(
  tx: CatalogTx,
  tenantId: string,
  variantIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of variantIds) {
    // eslint-disable-next-line no-await-in-loop -- bounded by the family's variant count, before any lock is taken
    out.push(...(await peekProductCodes(tx, tenantId, id)));
  }
  return out;
}

/**
 * Under the family row lock: deactivate every ACTIVE variant of `familyId`, in id order, releasing each one's codes
 * BEFORE its `isActive` write (SA-603a / Opus #2860 B1). `lockedCodes` is the set the caller already locked in its ONE
 * sorted call: a variant that gained a live code since is a 409 CODES_CHANGED (inside `releaseProductCodes`), never a
 * late lock. Returns the ids deactivated.
 */
export async function cascadeDeactivate(
  tx: CatalogTx,
  input: {
    tenantId: string;
    familyId: string;
    lockedCodes: ReadonlySet<string>;
    /** The caller's `confirmCascade`. Without it, a variant that is active under the lock is the 409, not a cascade. */
    confirmed: boolean;
  },
): Promise<string[]> {
  const { tenantId, familyId, lockedCodes, confirmed } = input;
  const ids = await activeVariantIds(tx, tenantId, familyId);
  if (ids.length > 0 && !confirmed) throw familyHasActiveVariants(ids.length);
  for (const productId of ids) {
    // eslint-disable-next-line no-await-in-loop -- id order, one row lock at a time
    await releaseProductCodes(tx, { tenantId, productId, lockedCodes });
  }
  if (ids.length > 0) {
    await tx.product.updateMany({
      where: { tenantId, id: { in: ids } },
      data: { isActive: false },
    });
  }
  return ids;
}

/**
 * A variant is being REACTIVATED under `parentId` (its current, unchanged parent): lock the family row FIRST (house
 * order: family before variant), then refuse with 409 VARIANT_PARENT_INACTIVE while it is inactive. A parent that
 * is gone reads as inactive-free (nothing to protect).
 */
export async function assertParentActiveForReactivation(
  tx: CatalogTx,
  input: { tenantId: string; parentId: string },
): Promise<void> {
  const { tenantId, parentId } = input;
  await lockProductRow(tx, tenantId, parentId);
  const parent: { isActive: boolean; name: string } | null = await tx.product.findFirst({
    where: { id: parentId, tenantId },
    select: { isActive: true, name: true },
  });
  if (parent && !parent.isActive) {
    throw new ConflictException({
      code: API_ERROR_CODES.VARIANT_PARENT_INACTIVE,
      message: `Its family "${parent.name}" is inactive. Reactivate the family first, then this variant.`,
      parentProductId: parentId,
    });
  }
}
