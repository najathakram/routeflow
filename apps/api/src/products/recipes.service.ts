import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RecipeDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { lockFamilyRow, readFamilyPriceMode } from "./family-price";
import { lockProductRow, lockProductRowsShared, type CatalogTx } from "./product-catalog-sync";
import { CreateRecipeDto, RecipeComponentInputDto, UpdateRecipeDto } from "./dto/recipe.dto";
import {
  assertRecipeEditable,
  assertRecipeProducts,
  assertRecipeShape,
  recipeActiveConflict,
  recipeInvalid,
  recipeUniqueViolation,
  recipeVersionConflict,
  type RuleProduct,
} from "./recipe-rules";

const RULE_SELECT = {
  id: true,
  parentProductId: true,
  kind: true,
  isActive: true,
  trackedCategoryId: true,
  unitsPerBox: true,
  familyPriceOverride: true,
} as const;

const WITH_COMPONENTS = { components: { orderBy: { position: "asc" as const } } };

type RecipeRow = {
  id: string;
  productId: string;
  familyProductId: string;
  version: number;
  unitsPerPack: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  activeFor: string | null;
  effectiveFrom: Date | null;
  retiredAt: Date | null;
  components: Array<{ id: string; componentProductId: string; qty: number; position: number }>;
};

export function toRecipeDto(row: RecipeRow): RecipeDto {
  return {
    id: row.id,
    productId: row.productId,
    familyProductId: row.familyProductId,
    version: row.version,
    unitsPerPack: row.unitsPerPack,
    status: row.status,
    activeFor: row.activeFor ?? null,
    effectiveFrom: row.effectiveFrom ? new Date(row.effectiveFrom).toISOString() : null,
    retiredAt: row.retiredAt ? new Date(row.retiredAt).toISOString() : null,
    components: (row.components ?? []).map((c) => ({
      id: c.id,
      componentProductId: c.componentProductId,
      qty: c.qty,
      position: c.position,
    })),
  };
}

/**
 * #2717 M2 (SA-572 A4, SA-574): versioned fixed recipes. Every method is gated on the tenant's
 * `mixed_packs` mode being `on` (Q6) before it reads anything. A recipe version is immutable once
 * it leaves DRAFT (I3, SA-579 — its component rows included); one ACTIVE version per recipe
 * product is `Recipe.activeFor` under a unique index, and every state change takes the recipe
 * Product row lock FIRST (L-239) and treats what it read before the lock as an expectation, not a
 * fact — a change that landed in between is a 409, never a silent overwrite.
 */
@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureConfig: FeatureConfigService,
  ) {}

  private async assertOn(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("No tenant context");
    if ((await readFamilyPriceMode(this.featureConfig, tenantId)) !== "on") {
      throw new ForbiddenException("Mixed packs is not enabled for this tenant");
    }
    return tenantId;
  }

  private async loadComponentProducts(
    inputs: RecipeComponentInputDto[],
  ): Promise<Array<{ componentProductId: string; qty: number; product: RuleProduct | undefined }>> {
    const ids = Array.from(new Set(inputs.map((c) => c.componentProductId))).filter(
      (id) => typeof id === "string" && id.length > 0,
    );
    const found: RuleProduct[] =
      ids.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: ids } },
            select: RULE_SELECT,
          })
        : [];
    const byId = new Map(found.map((p) => [p.id, p]));
    return inputs.map((c) => ({
      componentProductId: c.componentProductId,
      qty: c.qty,
      product: byId.get(c.componentProductId),
    }));
  }

  private async loadProduct(id: string, label: string): Promise<RuleProduct> {
    const row: RuleProduct | null = await this.prisma.forTenant().product.findFirst({
      where: { id },
      select: RULE_SELECT,
    });
    if (!row) throw new NotFoundException(`${label} not found`);
    return row;
  }

  private async readRecipe(client: CatalogTx, id: string, tenantId: string): Promise<RecipeRow> {
    const row: RecipeRow | null = await client.recipe.findFirst({
      where: { id, tenantId },
      include: WITH_COMPONENTS,
    });
    if (!row) throw new NotFoundException("Recipe not found");
    return row;
  }

  private mapUnique(e: unknown): never {
    const which = recipeUniqueViolation(e);
    if (which === "activeFor") throw recipeActiveConflict();
    if (which === "productVersion") throw recipeVersionConflict();
    throw e;
  }

  /**
   * The ONLY writer of RecipeComponent rows (recipe-component-writers.spec.ts pins that). SA-579:
   * a non-DRAFT recipe refuses any component write with 409 RECIPE_IMMUTABLE before a row moves.
   */
  private async writeComponents(
    tx: CatalogTx,
    recipe: { id: string; status: string },
    tenantId: string,
    rows: Array<{ componentProductId: string; qty: number; position: number }>,
    mode: "append" | "replace",
  ): Promise<void> {
    assertRecipeEditable(recipe);
    if (!recipe.id || !tenantId)
      throw new Error("writeComponents: recipe id and tenant id required");
    if (mode === "replace") {
      await tx.recipeComponent.deleteMany({ where: { recipeId: recipe.id, tenantId } });
    }
    if (rows.length > 0) {
      await tx.recipeComponent.createMany({
        data: rows.map((r) => ({
          tenantId,
          recipeId: recipe.id,
          componentProductId: r.componentProductId,
          qty: r.qty,
          position: r.position,
        })),
      });
    }
  }

  /**
   * HOUSE LOCK ORDER (product-catalog-sync.ts, SA-584 B2 c): the FAMILY row FOR UPDATE, then the
   * recipe-product row FOR UPDATE, then every component row FOR SHARE in id order. A concurrent
   * re-parent / deactivation / box-size edit of any of them waits for this tx (or has already
   * committed, and the re-validation below sees it). With no `componentIds` the components are the
   * recipe's current rows, read AFTER the recipe-product lock (every component writer holds it) and
   * returned so the caller can re-validate exactly what is locked.
   */
  private async lockRecipeRows(
    tx: CatalogTx,
    tenantId: string,
    input: {
      familyId: string;
      recipeProductId: string;
      recipeId?: string;
      componentIds?: string[];
    },
  ): Promise<Array<{ componentProductId: string; qty: number; position: number }> | null> {
    await lockFamilyRow(tx, tenantId, input.familyId);
    await lockProductRow(tx, tenantId, input.recipeProductId);
    let current: Array<{ componentProductId: string; qty: number; position: number }> | null = null;
    let ids = input.componentIds;
    if (!ids) {
      if (!input.recipeId) throw new Error("lockRecipeRows: recipeId or componentIds required");
      current = await tx.recipeComponent.findMany({
        where: { recipeId: input.recipeId, tenantId },
        select: { componentProductId: true, qty: true, position: true },
        orderBy: { position: "asc" },
      });
      ids = (current ?? []).map((c) => c.componentProductId);
    }
    await lockProductRowsShared(tx, tenantId, ids);
    return current;
  }

  /**
   * SA-584 B2 (b): the I2/I6/Q1/Q10 rules again, INSIDE the tx and AFTER the locks, on rows read
   * through `tx` (tenant-scoped like every tx client) — what the pre-lock read validated is only an
   * expectation (L-239). A component re-parented, deactivated or a family resized since is refused.
   */
  private async revalidateShape(
    tx: CatalogTx,
    input: {
      unitsPerPack: number;
      familyId: string;
      recipeProductId: string;
      inputs: Array<{ componentProductId: string; qty: number }>;
    },
  ): Promise<void> {
    const ids = Array.from(
      new Set([
        input.familyId,
        input.recipeProductId,
        ...input.inputs.map((c) => c.componentProductId),
      ]),
    ).filter((id) => typeof id === "string" && id.length > 0);
    const found: RuleProduct[] = await tx.product.findMany({
      where: { id: { in: ids } },
      select: RULE_SELECT,
    });
    const byId = new Map(found.map((p) => [p.id, p]));
    const family = byId.get(input.familyId);
    if (!family) throw new NotFoundException("Family product not found");
    const recipeProduct = byId.get(input.recipeProductId);
    if (!recipeProduct) throw new NotFoundException("Recipe product not found");
    const recipeProductVariantCount: number = await tx.product.count({
      where: { parentProductId: input.recipeProductId },
    });
    assertRecipeProducts({ family, recipeProduct, recipeProductVariantCount });
    assertRecipeShape({
      unitsPerPack: input.unitsPerPack,
      family,
      recipeProduct,
      recipeProductVariantCount,
      components: input.inputs.map((c) => ({
        componentProductId: c.componentProductId,
        qty: c.qty,
        product: byId.get(c.componentProductId),
      })),
    });
  }

  private positioned(inputs: RecipeComponentInputDto[]) {
    return inputs.map((c, i) => ({
      componentProductId: c.componentProductId,
      qty: c.qty,
      position: c.position ?? i,
    }));
  }

  async create(dto: CreateRecipeDto, createdById?: string | null): Promise<RecipeDto> {
    const tenantId = await this.assertOn();
    const db = this.prisma.forTenant();
    const recipeProduct = await this.loadProduct(dto.recipeProductId, "Recipe product");
    const family = await this.loadProduct(dto.familyProductId, "Family product");
    const recipeProductVariantCount: number = await db.product.count({
      where: { parentProductId: recipeProduct.id },
    });
    assertRecipeProducts({ family, recipeProduct, recipeProductVariantCount });
    const existing = await db.recipe.findFirst({
      where: { productId: recipeProduct.id },
      select: { id: true },
    });
    if (existing) {
      throw recipeInvalid(
        "RECIPE_PRODUCT_HAS_RECIPE",
        "This product already has a recipe. Create a new version of it instead.",
        409,
      );
    }
    const inputs = dto.components ?? [];
    assertRecipeShape({
      unitsPerPack: dto.unitsPerPack,
      family,
      recipeProduct,
      recipeProductVariantCount,
      components: await this.loadComponentProducts(inputs),
    });

    const created = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      await this.lockRecipeRows(tx, tenantId, {
        familyId: family.id,
        recipeProductId: recipeProduct.id,
        componentIds: inputs.map((c) => c.componentProductId),
      });
      const raced = await tx.recipe.findFirst({
        where: { productId: recipeProduct.id, tenantId },
        select: { id: true },
      });
      if (raced) {
        throw recipeInvalid(
          "RECIPE_PRODUCT_HAS_RECIPE",
          "This product already has a recipe. Create a new version of it instead.",
          409,
        );
      }
      await this.revalidateShape(tx, {
        unitsPerPack: dto.unitsPerPack,
        familyId: family.id,
        recipeProductId: recipeProduct.id,
        inputs,
      });
      let recipe: { id: string; status: string };
      try {
        recipe = await tx.recipe.create({
          data: {
            tenantId,
            productId: recipeProduct.id,
            familyProductId: family.id,
            version: 1,
            unitsPerPack: dto.unitsPerPack,
            status: "DRAFT",
            activeFor: null,
            createdById: createdById ?? null,
          },
        });
      } catch (e) {
        this.mapUnique(e);
      }
      await this.writeComponents(tx, recipe, tenantId, this.positioned(inputs), "append");
      await tx.product.update({ where: { id: recipeProduct.id }, data: { kind: "RECIPE" } });
      return this.readRecipe(tx, recipe.id, tenantId);
    });
    return toRecipeDto(created);
  }

  async findOne(id: string): Promise<RecipeDto> {
    const tenantId = await this.assertOn();
    return toRecipeDto(await this.readRecipe(this.prisma.forTenant() as CatalogTx, id, tenantId));
  }

  async list(productId?: string): Promise<RecipeDto[]> {
    await this.assertOn();
    const rows: RecipeRow[] = await this.prisma.forTenant().recipe.findMany({
      where: productId ? { productId } : {},
      include: WITH_COMPONENTS,
      orderBy: [{ productId: "asc" }, { version: "desc" }],
    });
    return rows.map(toRecipeDto);
  }

  /** DRAFT only (I3): a non-DRAFT version is 409 RECIPE_IMMUTABLE — before validation, and again under the lock. */
  async update(id: string, dto: UpdateRecipeDto): Promise<RecipeDto> {
    const tenantId = await this.assertOn();
    const db = this.prisma.forTenant();
    const recipe: {
      id: string;
      productId: string;
      familyProductId: string;
      status: string;
      unitsPerPack: number;
    } | null = await db.recipe.findFirst({
      where: { id },
      select: {
        id: true,
        productId: true,
        familyProductId: true,
        status: true,
        unitsPerPack: true,
      },
    });
    if (!recipe) throw new NotFoundException("Recipe not found");
    assertRecipeEditable(recipe);

    const unitsPerPack = dto.unitsPerPack ?? recipe.unitsPerPack;
    const inputs: RecipeComponentInputDto[] =
      dto.components ??
      (await db.recipeComponent.findMany({
        where: { recipeId: recipe.id },
        select: { componentProductId: true, qty: true, position: true },
        orderBy: { position: "asc" },
      }));
    const family = await this.loadProduct(recipe.familyProductId, "Family product");
    const recipeProduct = await this.loadProduct(recipe.productId, "Recipe product");
    assertRecipeShape({
      unitsPerPack,
      family,
      recipeProduct,
      recipeProductVariantCount: 0,
      components: await this.loadComponentProducts(inputs),
    });

    const updated = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      const current = await this.lockRecipeRows(tx, tenantId, {
        familyId: recipe.familyProductId,
        recipeProductId: recipe.productId,
        recipeId: recipe.id,
        componentIds: dto.components?.map((c) => c.componentProductId),
      });
      const fresh: { id: string; status: string; unitsPerPack: number } | null =
        await tx.recipe.findFirst({
          where: { id: recipe.id, tenantId },
          select: { id: true, status: true, unitsPerPack: true },
        });
      if (!fresh) throw new NotFoundException("Recipe not found");
      assertRecipeEditable(fresh);
      await this.revalidateShape(tx, {
        unitsPerPack: dto.unitsPerPack ?? fresh.unitsPerPack,
        familyId: recipe.familyProductId,
        recipeProductId: recipe.productId,
        inputs: dto.components ?? current ?? [],
      });
      if (dto.unitsPerPack !== undefined) {
        await tx.recipe.update({ where: { id: recipe.id }, data: { unitsPerPack } });
      }
      if (dto.components !== undefined) {
        await this.writeComponents(tx, fresh, tenantId, this.positioned(inputs), "replace");
      }
      return this.readRecipe(tx, recipe.id, tenantId);
    });
    return toRecipeDto(updated);
  }

  /** What the version request saw before the lock: the source and the number it expects to take. */
  private async loadVersionPlan(id: string) {
    const source: {
      id: string;
      productId: string;
      familyProductId: string;
      unitsPerPack: number;
    } | null = await this.prisma.forTenant().recipe.findFirst({
      where: { id },
      select: { id: true, productId: true, familyProductId: true, unitsPerPack: true },
    });
    if (!source) throw new NotFoundException("Recipe not found");
    const agg = await this.prisma.forTenant().recipe.aggregate({
      where: { productId: source.productId },
      _max: { version: true },
    });
    return { source, nextVersion: (agg._max.version ?? 0) + 1 };
  }

  /** Clone any version (whatever its status) into a new DRAFT with the next version number. */
  async createVersion(id: string, createdById?: string | null): Promise<RecipeDto> {
    const tenantId = await this.assertOn();
    const { source, nextVersion } = await this.loadVersionPlan(id);
    const created = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      // SA-584b: clone AS-IS under the locks, with NO shape validation (cloning is how a broken ACTIVE
      // recipe gets repaired); `activate` is the only gate.
      const rows = (await this.lockRecipeRows(tx, tenantId, {
        familyId: source.familyProductId,
        recipeProductId: source.productId,
        recipeId: source.id,
      })) as Array<{ componentProductId: string; qty: number; position: number }>;
      const agg = await tx.recipe.aggregate({
        where: { productId: source.productId, tenantId },
        _max: { version: true },
      });
      if ((agg._max.version ?? 0) + 1 !== nextVersion) throw recipeVersionConflict();
      const fresh: { unitsPerPack: number } | null = await tx.recipe.findFirst({
        where: { id: source.id, tenantId },
        select: { unitsPerPack: true },
      });
      if (!fresh) throw new NotFoundException("Recipe not found");
      let recipe: { id: string; status: string };
      try {
        recipe = await tx.recipe.create({
          data: {
            tenantId,
            productId: source.productId,
            familyProductId: source.familyProductId,
            version: nextVersion,
            unitsPerPack: fresh.unitsPerPack,
            status: "DRAFT",
            activeFor: null,
            createdById: createdById ?? null,
          },
        });
      } catch (e) {
        this.mapUnique(e);
      }
      await this.writeComponents(tx, recipe, tenantId, rows, "append");
      return this.readRecipe(tx, recipe.id, tenantId);
    });
    return toRecipeDto(created);
  }

  /** What the activation saw before the lock: the recipe and the ACTIVE version it expects to retire. */
  private async loadActivationPlan(id: string) {
    const recipe: {
      id: string;
      productId: string;
      familyProductId: string;
      status: string;
    } | null = await this.prisma.forTenant().recipe.findFirst({
      where: { id },
      select: { id: true, productId: true, familyProductId: true, status: true },
    });
    if (!recipe) throw new NotFoundException("Recipe not found");
    const prior: { id: string } | null = await this.prisma.forTenant().recipe.findFirst({
      where: { productId: recipe.productId, status: "ACTIVE" },
      select: { id: true },
    });
    return { recipe, priorActiveId: prior?.id ?? null };
  }

  /**
   * Retire the prior ACTIVE version and activate this DRAFT, in one transaction, under the recipe
   * Product row lock. Compare-and-set (L-239): what the request read before the lock is an
   * expectation — if the ACTIVE row under the lock is not the one it saw, or either status update
   * moves a different row count than expected, it is 409 RECIPE_ACTIVE_CONFLICT.
   */
  async activate(id: string): Promise<RecipeDto> {
    const tenantId = await this.assertOn();
    const { recipe, priorActiveId } = await this.loadActivationPlan(id);
    assertRecipeEditable(recipe);
    const activated = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      const rows = await this.lockRecipeRows(tx, tenantId, {
        familyId: recipe.familyProductId,
        recipeProductId: recipe.productId,
        recipeId: recipe.id,
      });
      const fresh: { status: string; unitsPerPack: number } | null = await tx.recipe.findFirst({
        where: { id: recipe.id, tenantId },
        select: { status: true, unitsPerPack: true },
      });
      if (!fresh) throw new NotFoundException("Recipe not found");
      if (fresh.status !== "DRAFT") throw recipeActiveConflict();
      const current: { id: string } | null = await tx.recipe.findFirst({
        where: { productId: recipe.productId, tenantId, status: "ACTIVE" },
        select: { id: true },
      });
      if ((current?.id ?? null) !== priorActiveId) throw recipeActiveConflict();
      const componentCount: number = await tx.recipeComponent.count({
        where: { recipeId: recipe.id, tenantId },
      });
      if (componentCount === 0) {
        throw recipeInvalid(
          "NO_COMPONENTS",
          "A recipe needs at least one component to be activated.",
        );
      }
      await this.revalidateShape(tx, {
        unitsPerPack: fresh.unitsPerPack,
        familyId: recipe.familyProductId,
        recipeProductId: recipe.productId,
        inputs: rows ?? [],
      });
      const now = new Date();
      try {
        if (current) {
          const retired: { count: number } = await tx.recipe.updateMany({
            where: { id: current.id, tenantId, status: "ACTIVE" },
            data: { status: "RETIRED", activeFor: null, retiredAt: now },
          });
          if (retired.count !== 1) throw recipeActiveConflict();
        }
        const activatedRows: { count: number } = await tx.recipe.updateMany({
          where: { id: recipe.id, tenantId, status: "DRAFT" },
          data: { status: "ACTIVE", activeFor: recipe.productId, effectiveFrom: now },
        });
        if (activatedRows.count !== 1) throw recipeActiveConflict();
      } catch (e) {
        this.mapUnique(e);
      }
      return this.readRecipe(tx, recipe.id, tenantId);
    });
    return toRecipeDto(activated);
  }
}
