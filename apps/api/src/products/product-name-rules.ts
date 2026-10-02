import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { CatalogTx } from "./product-catalog-sync";

/**
 * SA-603a (a) / SA-603b: a product name is unique among ACTIVE products of its scope (standalone, or siblings of one
 * parent), case-insensitively. An inactive product never blocks a name. The check runs under an xact advisory lock keyed
 * `(tenantId, parentScope, lower(name))` so two concurrent creates cannot both pass; the two active-only partial unique
 * indexes are the DB backstop (P2002 on either maps to the same 409 via `mapNameUniqueViolation`).
 */
const NAME_LOCK_FAMILY = "product-name";

/** The names of the two active-only partial uniques the Sitting-B bundle creates (SA-603b). */
const NAME_CONSTRAINT_NAMES: ReadonlySet<string> = new Set([
  "Product_tenant_root_name_active_key",
  "Product_tenant_parent_name_active_key",
]);

export function nameTakenMessage(name: string, hasParent: boolean): string {
  return hasParent
    ? `A variant named "${name}" already exists for this product`
    : `A product named "${name}" already exists`;
}

export async function lockProductName(
  tx: CatalogTx,
  tenantId: string,
  parentProductId: string | null,
  name: string,
): Promise<void> {
  const key = `${tenantId}:${parentProductId ?? ""}:${name.toLowerCase()}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${NAME_LOCK_FAMILY}), hashtext(${key}))`;
}

/**
 * Under the name lock: does another ACTIVE product of this scope hold `name`? `excludeId` is the product being
 * updated/reactivated. Throws 409 NAME_TAKEN naming the holder.
 */
export async function assertNameFree(
  tx: CatalogTx,
  input: {
    tenantId: string;
    parentProductId: string | null;
    name: string;
    excludeId: string | null;
    reactivating?: boolean;
  },
): Promise<void> {
  const { tenantId, parentProductId, name, excludeId } = input;
  await lockProductName(tx, tenantId, parentProductId, name);
  const holder: { id: string; name: string } | null = await tx.product.findFirst({
    where: {
      tenantId,
      isActive: true,
      name: { equals: name, mode: "insensitive" },
      parentProductId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (!holder) return;
  throw new ConflictException({
    code: API_ERROR_CODES.NAME_TAKEN,
    message: input.reactivating
      ? `Can't reactivate: an active product named "${name}" already exists. Rename one of them first.`
      : nameTakenMessage(name, parentProductId != null),
    // Uniform with CODE_TAKEN (SA/lead ruling): the same flat keys, the field being "name".
    field: "name",
    value: name,
    productId: holder.id,
    productName: holder.name,
  });
}

/** A P2002 on either active-name partial unique (driver-adapter or native shape) -> the same 409; else rethrown. */
export function mapNameUniqueViolation(e: unknown, name: string, hasParent: boolean): never {
  const err = e as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
    };
  };
  if (err?.code === "P2002") {
    const target = err.meta?.target;
    const index = err.meta?.driverAdapterError?.cause?.constraint?.index;
    if (
      (typeof target === "string" && NAME_CONSTRAINT_NAMES.has(target)) ||
      (typeof index === "string" && NAME_CONSTRAINT_NAMES.has(index))
    ) {
      throw new ConflictException({
        code: API_ERROR_CODES.NAME_TAKEN,
        message: nameTakenMessage(name, hasParent),
        field: "name",
        value: name,
      });
    }
  }
  throw e;
}
