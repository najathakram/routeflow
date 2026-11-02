import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  familyCellsFor,
  familyMoveOf,
  familyPriceOnPack,
  getTierPrice,
  resolveFamilyCellEdits,
  roundMoney,
  type FamilyLadderRow,
  type FamilyMove,
  type VariantLadderRow,
} from "@routeflow/pricing";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { newProductTierFallback } from "./new-product-tiers";
import { lockProductRow, type CatalogTx } from "./product-catalog-sync";

/**
 * #2717 M2 (SA-574 Q2): while a tenant's `mixed_packs` mode is `on`, a family edit copies every column `getTierPrice`
 * reads onto the recipe products that have not opted out with `familyPriceOverride`, and a recipe tier write that would
 * diverge is refused with 409. Mode `off` (the default for every tenant) leaves those writers exactly as they were.
 *
 * SA-1082 A-1: variants are out of that. In any mode a variant moves only through `moveFamilyVariants`, when the person
 * saving the family named it, and only if it's still at the family's price under the family's lock.
 *
 * Every writer of these columns is either routed through this file or exempt with a written reason
 * (family-price-writer-tripwire.spec.ts, L-223).
 */
export const MIXED_PACKS_KEY = "mixed_packs";

/** SA-823: why the product import refuses to regroup while family pricing is on (the 409 body message). */
export const IMPORT_FAMILY_PRICING_ON_MESSAGE =
  "Family pricing is on, so grouping would change these products' prices. Turn family pricing off, or group them in the product editor.";

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

/**
 * The family that owns a governed product's price: its parent, else the family its recipe links to
 * (SA-1041 A-2). Never the product itself; a "family" verdict without either is a broken invariant.
 */
export function familyOwnerIdOf(p: {
  parentProductId?: string | null;
  recipeFamilyId?: string | null;
}): string {
  const id = p.parentProductId ?? p.recipeFamilyId;
  if (!id) throw new Error("price authority is family but the product has no owning family");
  return id;
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

/** The family a RECIPE product's latest recipe links to, or null when it has no recipe. */
export async function recipeFamilyIdOf(
  db: Pick<CatalogTx, "recipe">,
  tenantId: string,
  productId: string,
): Promise<string | null> {
  const recipe: { familyProductId: string } | null = await db.recipe.findFirst({
    where: { productId, tenantId },
    orderBy: { version: "desc" },
    select: { familyProductId: true },
  });
  return recipe?.familyProductId ?? null;
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

/** The family's five columns as a variant on `pieces` holds them (SA-1082 A-2's scale, once); a blank tier stays blank. */
function familyColumnsFor(
  family: Record<FamilyPriceColumn, PriceValue>,
  familyPack: unknown,
  pieces: unknown,
): Record<FamilyPriceColumn, Prisma.Decimal> {
  const out = {} as Record<FamilyPriceColumn, unknown>;
  for (const col of FAMILY_PRICE_COLUMNS) {
    const value = Number(family[col]) || 0;
    out[col] = value > 0 ? familyPriceOnPack(value, familyPack, pieces) : family[col];
  }
  return out as Record<FamilyPriceColumn, Prisma.Decimal>;
}

/**
 * The five columns a NEW variant of `familyId` is created with while the mode is on: the family's, read under its row
 * lock and scaled to the variant's pack (SA-1082 ruling 1). A price the dto names is the variant's own; a Retail apart
 * from the family's leaves the tiers it didn't name blank, so they read Auto.
 */
export async function familyPricesForNewVariant(
  tx: CatalogTx,
  input: {
    tenantId: string;
    familyId: string;
    dto: PriceColumns;
    unitsPerBox?: unknown;
    flagged?: boolean;
  },
): Promise<Record<FamilyPriceColumn, Prisma.Decimal>> {
  const family = await loadLockedFamilyPrices(tx, input.tenantId, input.familyId);
  const pack = await tx.product.findFirst({
    where: { id: input.familyId, tenantId: input.tenantId },
    select: { unitsPerBox: true },
  });
  const scaled = familyColumnsFor(family, pack?.unitsPerBox, input.unitsPerBox);
  const typed = definedPriceColumns(input.dto);
  if (Object.keys(typed).length === 0) return scaled;
  const retail = String(typed.pricePerUnit ?? scaled.pricePerUnit);
  const ownRetail = roundMoney(Number(retail)) !== roundMoney(Number(scaled.pricePerUnit));
  const out = { ...scaled } as Record<FamilyPriceColumn, unknown>;
  for (const col of FAMILY_PRICE_COLUMNS) {
    if (typed[col] !== undefined) out[col] = typed[col];
    else if (ownRetail && col !== "pricePerUnit") {
      out[col] = newProductTierFallback(input.flagged === true, retail);
    }
  }
  return out as Record<FamilyPriceColumn, Prisma.Decimal>;
}

const LADDER_SELECT = { ...PRICE_SELECT, unitsPerBox: true } as const;

/** A family's ladder as a move compares it, locked: the family save's values before its own write. */
export async function loadLockedFamilyLadder(
  tx: CatalogTx,
  tenantId: string,
  familyId: string,
): Promise<FamilyLadderRow> {
  await lockFamilyRow(tx, tenantId, familyId);
  const family = await tx.product.findFirst({
    where: { id: familyId, tenantId },
    select: LADDER_SELECT,
  });
  if (!family) throw new BadRequestException("Family product not found");
  return family as FamilyLadderRow;
}

/** SA-1082: a variant with an order unit of its own, or a tier unit that isn't the pack, works its numbers out from that. */
const hasOwnOrderUnit = (ref: string | null | undefined): boolean => !!ref && ref !== "pack";

/** The family's live variants (`ids` narrows them) with what the pure move reads. One read for the ask and the write. */
export async function loadVariantLadders(
  db: Pick<CatalogTx, "product" | "productTierUnit">,
  input: { tenantId: string; familyId: string; ids?: readonly string[] },
): Promise<Array<VariantLadderRow & { id: string; name: string; variantName: string | null }>> {
  const { tenantId, familyId, ids } = input;
  if (!tenantId || !familyId) throw new Error("loadVariantLadders: tenant and family are required");
  const rows: Array<
    FamilyLadderRow & {
      id: string;
      name: string;
      variantName: string | null;
      orderUnitRef: string | null;
      packAuto: number | null;
    }
  > = await db.product.findMany({
    where: {
      tenantId,
      parentProductId: familyId,
      isActive: true,
      ...(ids ? { id: { in: [...ids] } } : {}),
    },
    select: {
      ...LADDER_SELECT,
      id: true,
      name: true,
      variantName: true,
      orderUnitRef: true,
      packAuto: true,
    },
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) return [];
  const tierUnits: Array<{ productId: string; orderUnitRef: string | null }> =
    await db.productTierUnit.findMany({
      where: { productId: { in: rows.map((r) => r.id) } },
      select: { productId: true, orderUnitRef: true },
    });
  const ownTierUnit = new Set(
    tierUnits.filter((t) => hasOwnOrderUnit(t.orderUnitRef)).map((t) => t.productId),
  );
  return rows.map((r) => ({
    ...r,
    ownOrderUnit: hasOwnOrderUnit(r.orderUnitRef) || ownTierUnit.has(r.id),
  }));
}

/** The variants a save from `before` to `after` would ask about, and what each would become. */
export function plannedFamilyMoves<T extends VariantLadderRow>(
  before: FamilyLadderRow,
  after: FamilyLadderRow,
  variants: readonly T[],
): Array<{ variant: T; move: FamilyMove }> {
  return variants.flatMap((variant) => {
    const move = familyMoveOf(before, after, variant);
    return move ? [{ variant, move }] : [];
  });
}

/**
 * THE one writer of a variant's prices from its family (SA-1082 A-1; the tripwire pins it). The caller holds the family's
 * row lock and passes the family's values from before its write. Each named variant is locked in id order, re-read and
 * re-checked: one that no longer matches stays where it is, even though it's named. One audit row gives the count.
 */
export async function moveFamilyVariants(
  tx: CatalogTx,
  input: {
    tenantId: string;
    familyId: string;
    before: FamilyLadderRow;
    after: FamilyLadderRow;
    variantIds: readonly string[];
    flagged: boolean;
    actorId?: string | null;
  },
): Promise<{ asked: number; moved: number }> {
  const { tenantId, familyId, before, after, flagged } = input;
  const ids = [...new Set(input.variantIds)].sort();
  if (ids.length === 0) return { asked: 0, moved: 0 };
  // House lock order (product-catalog-sync.ts): the family row first, then its variants in id order.
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- id order: two family saves cannot deadlock
    await lockProductRow(tx, tenantId, id);
  }
  const variants = await loadVariantLadders(tx, { tenantId, familyId, ids });
  const planned = plannedFamilyMoves(before, after, variants);
  for (const { variant, move } of planned) {
    const tier = (col: Exclude<FamilyPriceColumn, "pricePerUnit">) => {
      const to = move.columns[col];
      return to === null ? newProductTierFallback(flagged, String(move.to)) : to;
    };
    // eslint-disable-next-line no-await-in-loop -- under the locks above, one row per named variant
    await tx.product.update({
      where: { id: variant.id },
      data: {
        pricePerUnit: move.columns.pricePerUnit,
        priceTier2: tier("priceTier2"),
        priceTier3: tier("priceTier3"),
        priceTier4: tier("priceTier4"),
        priceTier5: tier("priceTier5"),
        packAuto: move.packAuto,
        priceRevision: { increment: 1 },
      },
    });
  }
  await tx.auditLog.create({
    data: {
      tenantId,
      userId: input.actorId ?? null,
      action: AUDIT_ACTIONS.PRODUCT_FAMILY_VARIANTS_MOVED,
      entityType: "product",
      entityId: familyId,
      meta: {
        asked: ids.length,
        moved: planned.length,
        variantIds: planned.map((p) => p.variant.id),
        retailBefore: String(before.pricePerUnit),
        retailAfter: String(after.pricePerUnit),
      },
    },
  });
  return { asked: ids.length, moved: planned.length };
}

/**
 * SA-1082 ruling 7, for the writers that aren't the price grid: a Retail typed away from the family's takes the tiers
 * still at the family's value with it, blank through `newProductTierFallback`, unless this save typed them. Returns the
 * tier columns to write. A tier the dto sends unchanged wasn't typed.
 */
export function ownRetailTierBlanks(input: {
  family: FamilyLadderRow;
  variant: VariantLadderRow;
  dto: PriceColumns;
  flagged: boolean;
}): Partial<Record<FamilyPriceColumn, string>> {
  const { family, variant, dto, flagged } = input;
  const retail = dto.pricePerUnit;
  const cells = familyCellsFor(family, variant);
  if (retail === undefined || retail === null || !cells) return {};
  const to = roundMoney(Number(retail));
  if (to === roundMoney(getTierPrice(variant, 1))) return {};
  const typed = [2, 3, 4, 5].flatMap((tier) => {
    const col = FAMILY_PRICE_COLUMNS[tier - 1] as FamilyPriceColumn;
    const value = dto[col];
    const same =
      value == null ||
      roundMoney(Number(value)) ===
        roundMoney(Number(variant[col as keyof VariantLadderRow] as unknown));
    return same ? [] : [{ tier, to: roundMoney(Number(value)) }];
  });
  const out: Partial<Record<FamilyPriceColumn, string>> = {};
  for (const edit of resolveFamilyCellEdits(cells, [{ tier: 1, to }, ...typed])) {
    if (edit.to === null) {
      out[FAMILY_PRICE_COLUMNS[edit.tier - 1] as FamilyPriceColumn] = newProductTierFallback(
        flagged,
        String(to),
      );
    }
  }
  return out;
}

/**
 * Copy the family's five columns onto every recipe product without `familyPriceOverride`, inside the caller's
 * transaction. Variants are never written here (SA-1082 A-1). Every many-write carries the tenant id and the recipe ids
 * in its where (an undefined where-key would widen it), so empty ids are refused before any query. One audit row names
 * the count when anything moved.
 */
export async function propagateFamilyPrice(
  tx: CatalogTx,
  input: { tenantId: string; familyId: string },
): Promise<{ recipes: number }> {
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
  // the recipe products.
  let recipes = { count: 0 };
  if (recipeProductIds.length > 0) {
    recipes = await tx.product.updateMany({
      where: { tenantId, id: { in: recipeProductIds }, familyPriceOverride: false },
      data,
    });
  }
  if (recipes.count > 0) {
    await tx.auditLog.create({
      data: {
        tenantId,
        action: "PRODUCT_FAMILY_PRICE_PROPAGATED",
        entityType: "product",
        entityId: familyId,
        meta: { recipes: recipes.count },
      },
    });
  }
  return { recipes: recipes.count };
}

const sameLadder = (a: PriceColumns, b: PriceColumns): boolean =>
  FAMILY_PRICE_COLUMNS.every((col) => Number(a[col] ?? 0) === Number(b[col] ?? 0));

/**
 * The family-price step of `ProductsService.update`, run inside its transaction BEFORE the row write
 * and only while the mode is on. It mutates `data` (the object about to be written) and returns
 * whether the caller must propagate this row's ladder to its recipes AFTER the write:
 *   - adopting a product into a family (parentProductId changes to a family): the family's five
 *     columns, scaled to its pack, replace the product's own, audited (Q9);
 *   - a price write on a variant: its own, and it stays in `data` (SA-1082 A-1);
 *   - a write to a recipe product without the override: a differing price is refused
 *     (409 FAMILY_PRICE_AUTHORITY), an equal one is dropped from `data`;
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
      unitsPerBox?: unknown;
    };
    dto: PriceColumns & { parentProductId?: string | null; unitsPerBox?: unknown };
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
      const ladder = await loadLockedFamilyLadder(tx, tenantId, effectiveParent);
      const family = familyColumnsFor(
        pickPriceColumns(ladder as PriceColumns),
        ladder.unitsPerBox,
        dto.unitsPerBox ?? existing.unitsPerBox,
      );
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
    return { propagate: false };
  }

  if (!priceWrite) return { propagate: false };

  if (existing.kind === "RECIPE") {
    if (existing.familyPriceOverride) return { propagate: false };
    const recipeFamilyId = await recipeFamilyIdOf(tx, tenantId, id);
    if (!recipeFamilyId) return { propagate: false };
    const family = await loadLockedFamilyPrices(tx, tenantId, recipeFamilyId);
    if (!variantPriceWriteDecision({ mode: "on", governed: true, dto, family }).allow) {
      throw familyPriceAuthorityError(recipeFamilyId);
    }
    dropPriceKeys();
    return { propagate: false };
  }

  await lockFamilyRow(tx, tenantId, id);
  return { propagate: true };
}
