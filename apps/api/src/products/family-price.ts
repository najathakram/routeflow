import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { getTierPrice, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockProductRow, type CatalogTx } from "./product-catalog-sync";

/**
 * #2717 M2 (SA-574 Q2): family price authority by WRITE-THROUGH. While a tenant's `mixed_packs`
 * mode is `on`, the family Product row owns the price ladder: a family edit copies every column
 * `getTierPrice` reads onto its variants (and onto recipe products that have not opted out with
 * `familyPriceOverride`), and a variant/recipe tier write that would diverge is refused with 409.
 * Mode `off` (the default for every tenant) leaves every writer exactly as it was.
 *
 * Every writer of these columns is either routed through this file or exempt with a written reason
 * (family-price-writer-tripwire.spec.ts, L-223).
 */
export const MIXED_PACKS_KEY = "mixed_packs";

/** The five columns `getTierPrice` reads, in ladder order. */
export const FAMILY_PRICE_COLUMNS = [
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
] as const;
export type FamilyPriceColumn = (typeof FAMILY_PRICE_COLUMNS)[number];
export type FamilyPriceMode = "on" | "off";

/** A price value as Prisma hands it back (Decimal), or as a DTO carries it (string/number). */
type PriceValue = { toString(): string } | string | number | null | undefined;
export type PriceColumns = Partial<Record<FamilyPriceColumn, PriceValue>>;

const PRICE_SELECT = {
  pricePerUnit: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
} as const;

/** All five columns of a row, raw (Decimals and nulls untouched). */
export function pickPriceColumns(row: PriceColumns): Record<FamilyPriceColumn, PriceValue> {
  const out = {} as Record<FamilyPriceColumn, PriceValue>;
  for (const col of FAMILY_PRICE_COLUMNS) out[col] = row[col] as PriceValue;
  return out;
}

/** The price keys a DTO actually carries (an absent key is not a price write). */
export function definedPriceColumns(dto: PriceColumns): PriceColumns {
  const out: PriceColumns = {};
  for (const col of FAMILY_PRICE_COLUMNS) if (dto[col] !== undefined) out[col] = dto[col];
  return out;
}

export const hasPriceColumns = (dto: PriceColumns): boolean =>
  Object.keys(definedPriceColumns(dto)).length > 0;

function effectiveLadder(row: PriceColumns): number[] {
  return [1, 2, 3, 4, 5].map((tier) => roundMoney(getTierPrice(row, tier)));
}

/**
 * PURE. Should a write carrying `dto` price columns be allowed on a row the family governs?
 * `governed` is the caller's verdict (a variant of a family, or a recipe product without
 * `familyPriceOverride`). Allowed when the mode is off, the row is not governed, the dto carries no
 * price key, or the merged ladder equals the family's EFFECTIVE ladder tier for tier (`getTierPrice`
 * semantics, `roundMoney` before comparing, L-170) — an idempotent client re-save.
 */
export function variantPriceWriteDecision(input: {
  mode: FamilyPriceMode;
  governed: boolean;
  dto: PriceColumns;
  family: PriceColumns;
}): { allow: boolean } {
  if (input.mode !== "on" || !input.governed) return { allow: true };
  const dto = definedPriceColumns(input.dto);
  if (Object.keys(dto).length === 0) return { allow: true };
  const merged = { ...input.family, ...dto };
  const want = effectiveLadder(input.family);
  const got = effectiveLadder(merged);
  return { allow: want.every((value, i) => value === got[i]) };
}

export function familyPriceAuthorityError(familyId: string): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY,
    message: "This price is set on the family product. Edit the family to change it.",
    familyId,
  });
}

/**
 * The tenant's effective `mixed_packs` mode. Anything but an explicit `on` is `off`; a missing
 * FeatureConfigService (a spec, a boot without the module) or a read failure is `off` too, so the
 * authority can only ever be switched on deliberately.
 */
export async function readFamilyPriceMode(
  featureConfig: { getEffectiveMode(tenantId: string, key: string): Promise<string> } | undefined,
  tenantId: string | null,
): Promise<FamilyPriceMode> {
  if (!featureConfig || !tenantId) return "off";
  try {
    return (await featureConfig.getEffectiveMode(tenantId, MIXED_PACKS_KEY)) === "on"
      ? "on"
      : "off";
  } catch {
    return "off";
  }
}

/** `SELECT … FOR UPDATE` on the family Product row: every family-price writer takes it first. */
export async function lockFamilyRow(
  tx: CatalogTx,
  tenantId: string,
  familyId: string,
): Promise<void> {
  await lockProductRow(tx, tenantId, familyId);
}

/** Lock the family row, THEN read its five columns (the read must see the post-lock committed row). */
export async function loadLockedFamilyPrices(
  tx: CatalogTx,
  tenantId: string,
  familyId: string,
): Promise<Record<FamilyPriceColumn, PriceValue>> {
  await lockFamilyRow(tx, tenantId, familyId);
  const family = await tx.product.findFirst({
    where: { id: familyId, tenantId },
    select: PRICE_SELECT,
  });
  if (!family) throw new BadRequestException("Parent product not found");
  return pickPriceColumns(family as PriceColumns);
}

/**
 * The five columns a NEW variant of `familyId` is created with while the mode is on: the family's,
 * read under its row lock. A dto that names a price differing from the family's is refused.
 */
export async function familyPricesForNewVariant(
  tx: CatalogTx,
  input: { tenantId: string; familyId: string; dto: PriceColumns },
): Promise<Record<FamilyPriceColumn, Prisma.Decimal>> {
  const family = await loadLockedFamilyPrices(tx, input.tenantId, input.familyId);
  const { allow } = variantPriceWriteDecision({
    mode: "on",
    governed: true,
    dto: input.dto,
    family,
  });
  if (!allow) throw familyPriceAuthorityError(input.familyId);
  // The columns are non-null Decimals in the schema, so the raw read is safe to write back as-is.
  return family as Record<FamilyPriceColumn, Prisma.Decimal>;
}

/**
 * Copy the family's five columns onto every variant and every recipe product without
 * `familyPriceOverride`, inside the caller's transaction. Every many-write carries the tenant id and
 * the family/recipe ids in its where (an undefined where-key would widen it), so empty ids are
 * refused before any query. One audit row names the counts when anything moved.
 */
export async function propagateFamilyPrice(
  tx: CatalogTx,
  input: { tenantId: string; familyId: string },
): Promise<{ variants: number; recipes: number }> {
  const { tenantId, familyId } = input;
  if (!tenantId || !familyId) {
    throw new Error("propagateFamilyPrice: tenantId and familyId are required");
  }
  const family = await tx.product.findFirst({
    where: { id: familyId, tenantId },
    select: PRICE_SELECT,
  });
  if (!family) throw new BadRequestException("Family product not found");
  const data = pickPriceColumns(family as PriceColumns);

  const recipeRows: Array<{ productId: string }> = await tx.recipe.findMany({
    where: { tenantId, familyProductId: familyId },
    select: { productId: true },
  });
  const recipeProductIds = Array.from(new Set(recipeRows.map((r) => r.productId))).filter(
    (id) => typeof id === "string" && id.length > 0,
  );

  // House lock order (product-catalog-sync.ts): the family row is already held by the caller, then
  // the recipe products, THEN the variant rows.
  let recipes = { count: 0 };
  if (recipeProductIds.length > 0) {
    recipes = await tx.product.updateMany({
      where: { tenantId, id: { in: recipeProductIds }, familyPriceOverride: false },
      data,
    });
  }
  const variants: { count: number } = await tx.product.updateMany({
    where: { tenantId, parentProductId: familyId },
    data,
  });

  if (variants.count + recipes.count > 0) {
    await tx.auditLog.create({
      data: {
        tenantId,
        action: "PRODUCT_FAMILY_PRICE_PROPAGATED",
        entityType: "product",
        entityId: familyId,
        meta: { variants: variants.count, recipes: recipes.count },
      },
    });
  }
  return { variants: variants.count, recipes: recipes.count };
}

const sameLadder = (a: PriceColumns, b: PriceColumns): boolean =>
  FAMILY_PRICE_COLUMNS.every((col) => Number(a[col] ?? 0) === Number(b[col] ?? 0));

/**
 * The family-price step of `ProductsService.update`, run inside its transaction BEFORE the row write
 * and only while the mode is on. It mutates `data` (the object about to be written) and returns
 * whether the caller must propagate this row's ladder to its children AFTER the write:
 *   - adopting a product into a family (parentProductId changes to a family): the family's five
 *     columns replace the product's own, audited (Q9);
 *   - a write to a row the family governs (a variant, or a recipe product without the override):
 *     a differing price is refused (409 FAMILY_PRICE_AUTHORITY), an equal one is dropped from `data`;
 *   - a price write on a family/standalone row: its own row lock is taken first, then the caller
 *     propagates.
 */
export async function applyFamilyPriceBeforeUpdate(
  tx: CatalogTx,
  input: {
    tenantId: string;
    id: string;
    existing: PriceColumns & {
      parentProductId: string | null;
      kind?: string | null;
      familyPriceOverride?: boolean | null;
    };
    dto: PriceColumns & { parentProductId?: string | null };
    data: Record<string, unknown>;
  },
): Promise<{ propagate: boolean }> {
  const { tenantId, id, existing, dto, data } = input;
  const effectiveParent =
    dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId;
  const priceWrite = hasPriceColumns(dto);
  const dropPriceKeys = () => {
    for (const col of FAMILY_PRICE_COLUMNS) delete data[col];
  };

  if (effectiveParent) {
    const adopting = !!dto.parentProductId && dto.parentProductId !== existing.parentProductId;
    if (adopting) {
      const family = await loadLockedFamilyPrices(tx, tenantId, effectiveParent);
      if (!sameLadder(existing, family)) {
        await tx.auditLog.create({
          data: {
            tenantId,
            action: "PRODUCT_ADOPTED_FAMILY_PRICE",
            entityType: "product",
            entityId: id,
            meta: {
              familyId: effectiveParent,
              before: Object.fromEntries(
                FAMILY_PRICE_COLUMNS.map((c) => [c, String(existing[c] ?? "")]),
              ),
              after: Object.fromEntries(FAMILY_PRICE_COLUMNS.map((c) => [c, String(family[c])])),
            },
          },
        });
      }
      Object.assign(data, family);
      return { propagate: false };
    }
    if (!priceWrite) return { propagate: false };
    const family = await loadLockedFamilyPrices(tx, tenantId, effectiveParent);
    if (!variantPriceWriteDecision({ mode: "on", governed: true, dto, family }).allow) {
      throw familyPriceAuthorityError(effectiveParent);
    }
    dropPriceKeys();
    return { propagate: false };
  }

  if (!priceWrite) return { propagate: false };

  if (existing.kind === "RECIPE") {
    if (existing.familyPriceOverride) return { propagate: false };
    const recipe: { familyProductId: string } | null = await tx.recipe.findFirst({
      where: { productId: id, tenantId },
      orderBy: { version: "desc" },
      select: { familyProductId: true },
    });
    if (!recipe) return { propagate: false };
    const family = await loadLockedFamilyPrices(tx, tenantId, recipe.familyProductId);
    if (!variantPriceWriteDecision({ mode: "on", governed: true, dto, family }).allow) {
      throw familyPriceAuthorityError(recipe.familyProductId);
    }
    dropPriceKeys();
    return { propagate: false };
  }

  await lockFamilyRow(tx, tenantId, id);
  return { propagate: true };
}
