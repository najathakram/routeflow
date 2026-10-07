import { BadRequestException } from "@nestjs/common";

/**
 * The ONE check for "may this product be given THIS parent": used by create(), update() and
 * bulkAssignParent(), so a parent id is judged the same way wherever it arrives.
 *
 * `db` is any client with `product.findFirst` / `product.count`: a transaction (update / create run
 * it under the family-row lock, so the answer cannot change before the write) or `forTenant()` (the
 * bulk entry point). The lookup always carries the tenant id, so another tenant's product is "not
 * found" exactly like a missing one, and nothing is written.
 *
 * Refuses (400) when the parent is missing, inactive, the product itself, or a variant; and, when
 * `id` is given, when the product being moved already has variants of its own (a variant of a
 * variant has no meaning). Returns the parent's `kind` so the caller can mark the child VARIANT
 * when the parent is a FAMILY.
 */
export type ParentDb = {
  product: {
    findFirst: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
  };
};

export async function assertValidParent(
  db: ParentDb,
  input: { tenantId: string; id: string | null; parentId: string },
): Promise<{ parentKind: string }> {
  const { tenantId, id, parentId } = input;
  if (id && parentId === id) {
    throw new BadRequestException("A product cannot be its own parent");
  }
  const parent = (await db.product.findFirst({
    where: { id: parentId, tenantId },
    select: { id: true, isActive: true, kind: true, parentProductId: true },
  })) as { id: string; isActive: boolean; kind: string; parentProductId: string | null } | null;
  if (!parent) throw new BadRequestException("Parent product not found");
  if (parent.parentProductId || parent.kind === "VARIANT") {
    throw new BadRequestException("Parent must be a standalone product, not a variant");
  }
  if (!parent.isActive) {
    throw new BadRequestException("The parent product is inactive");
  }
  if (id) {
    const children = await db.product.count({ where: { parentProductId: id, tenantId } });
    if (children > 0) {
      throw new BadRequestException(
        "This product has variants of its own, so it cannot become a variant",
      );
    }
  }
  return { parentKind: parent.kind };
}
