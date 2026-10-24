import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * The ONE check for "may this product be given THIS parent": used by create(), update(),
 * bulkAssignParent() and inventory assignToVariants(), so a parent id is judged the same way
 * wherever it arrives.
 *
 * `db` is any client with `product.findFirst` / `product.count`: a transaction (update / create run
 * it under the family-row lock, so the answer cannot change before the write) or `forTenant()` (the
 * bulk entry point). The lookup always carries the tenant id, so another tenant's product is "not
 * found" exactly like a missing one, and nothing is written.
 *
 * Refuses (400 PRODUCT_PARENT_INVALID, `reason` below) when the parent is missing, inactive, the
 * product itself, or a variant; and, when `id` is given, when the product being moved already has
 * variants of its own (a variant of a variant has no meaning). Returns the parent's `kind` so the
 * caller can mark the child VARIANT when the parent is a FAMILY.
 */
export type ParentDb = {
  product: {
    findFirst: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
  };
};

/** `reason` of the PRODUCT_PARENT_INVALID body: which rule the parent failed. */
export const PRODUCT_PARENT_REASONS = {
  NOT_FOUND: "NOT_FOUND",
  SELF: "SELF",
  VARIANT_PARENT: "VARIANT_PARENT",
  INACTIVE: "INACTIVE",
  HAS_VARIANTS: "HAS_VARIANTS",
} as const;

/** The sentence of the HAS_VARIANTS refusal (the import preview names the same rule without a parent to ask). */
export const HAS_VARIANTS_MESSAGE =
  "This product has variants of its own, so it cannot become a variant";

export type ProductParentReason =
  (typeof PRODUCT_PARENT_REASONS)[keyof typeof PRODUCT_PARENT_REASONS];

/** The 400 every refusal here throws: the registry code, a `reason`, and the user-facing sentence. */
export function parentInvalid(reason: ProductParentReason, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
    reason,
    message,
    error: "Bad Request",
  });
}

export type ParentRow = {
  id?: string;
  isActive?: boolean;
  kind?: string;
  parentProductId?: string | null;
};

/**
 * The judgement on an ALREADY-LOADED, tenant-scoped parent row: standalone (not a variant) and
 * active. `assertValidParent` runs it after its lookup; a caller that has loaded the parent row
 * itself under the same lock (inventory assignToVariants) runs it directly, so both apply one rule.
 */
export function assertParentUsable(parent: ParentRow): { parentKind: string } {
  if (parent.parentProductId || parent.kind === "VARIANT") {
    throw parentInvalid(
      PRODUCT_PARENT_REASONS.VARIANT_PARENT,
      "Parent must be a standalone product, not a variant",
    );
  }
  if (parent.isActive === false) {
    throw parentInvalid(PRODUCT_PARENT_REASONS.INACTIVE, "The parent product is inactive");
  }
  return { parentKind: parent.kind ?? "STANDARD" };
}

export async function assertValidParent(
  db: ParentDb,
  input: { tenantId: string; id: string | null; parentId: string },
): Promise<{ parentKind: string }> {
  const { tenantId, id, parentId } = input;
  if (id && parentId === id) {
    throw parentInvalid(PRODUCT_PARENT_REASONS.SELF, "A product cannot be its own parent");
  }
  const parent = (await db.product.findFirst({
    where: { id: parentId, tenantId },
    select: { id: true, isActive: true, kind: true, parentProductId: true },
  })) as { id: string; isActive: boolean; kind: string; parentProductId: string | null } | null;
  if (!parent) {
    throw parentInvalid(PRODUCT_PARENT_REASONS.NOT_FOUND, "Parent product not found");
  }
  const { parentKind } = assertParentUsable(parent);
  if (id) {
    const children = await db.product.count({ where: { parentProductId: id, tenantId } });
    if (children > 0) {
      throw parentInvalid(PRODUCT_PARENT_REASONS.HAS_VARIANTS, HAS_VARIANTS_MESSAGE);
    }
  }
  return { parentKind };
}

/**
 * Read-side twin of the write check (B1211): a parent row that belongs to ANOTHER tenant is treated as
 * "no parent". Write-time validation only protects links made after it shipped; a link that already
 * crosses tenants must still never be followed on a read. It fails CLOSED both ways: a caller with no
 * tenant (null/undefined/empty) gets null, and so does a row that does not carry its own `tenantId`,
 * so neither a missing tenant context nor a select that forgets the column can leak a parent.
 */
export function tenantSafeParent<T extends { tenantId?: string | null }>(
  parent: T | null | undefined,
  tenantId: string | null | undefined,
): T | null {
  if (!parent) return null;
  if (!tenantId) return null;
  return parent.tenantId === tenantId ? parent : null;
}

/**
 * `tenantSafeParent` for a response whose parent summary does not include `tenantId` (the list): the
 * column is selected only for the comparison and removed from what the caller receives.
 */
export function tenantSafeParentView<T extends { tenantId?: string | null }>(
  parent: T | null | undefined,
  tenantId: string | null | undefined,
): Omit<T, "tenantId"> | null {
  const safe = tenantSafeParent(parent, tenantId);
  if (!safe) return null;
  const view: Partial<T> = { ...safe };
  delete view.tenantId;
  return view as unknown as Omit<T, "tenantId">;
}

/**
 * SA-823 R11: which door moved a product under (or out of) a family; recorded as `via` on the
 * `product.family_assigned` audit row. A fifth source is one union member.
 */
export type FamilyAssignVia = "editor" | "bulk_assign" | "import" | "inventory" | "family_editor";

/**
 * SA-823b: the ONLY writer of `product.family_assigned`. Call it on the caller's transaction so the row rolls back with
 * the assignment. A missing tenant is a plain Error (never a silently tenant-less audit row).
 */
export async function writeFamilyAssigned(
  tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } },
  input: {
    tenantId: string | null | undefined;
    actorId?: string | null;
    productId: string;
    fromParentId: string | null;
    toParentId: string | null;
    variantName: string | null;
    via: FamilyAssignVia;
  },
): Promise<void> {
  if (!input.tenantId) throw new Error("writeFamilyAssigned requires a tenantId");
  await tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.actorId ?? null,
      action: AUDIT_ACTIONS.PRODUCT_FAMILY_ASSIGNED,
      entityType: "Product",
      entityId: input.productId,
      meta: {
        productId: input.productId,
        fromParentId: input.fromParentId,
        toParentId: input.toParentId,
        variantName: input.variantName,
        via: input.via,
      },
    },
  });
}

/** The narrow options of the reparent entries (assignToParent / unlinkFromParent): `via` is REQUIRED so no caller can omit it. */
export interface ReparentOptions {
  via: FamilyAssignVia;
  actorId?: string | null;
  actorName?: string | null;
  suppressEmit?: boolean;
  /**
   * SA-823 (PR-2): other UpdateProductDto fields to write in the SAME update() as the move (the import's price / cost
   * cells on a regrouped row), so the row is all-or-nothing. assignToParent's own parent / name / variantName win.
   */
  extraChanges?: Record<string, unknown>;
}
