import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { ProductAliasService } from "./product-alias.service";
import { roundMoney } from "@routeflow/pricing";

/** Default gross margin for a brand-new product's list price: cost × (1 + margin). */
const DEFAULT_MARGIN = 0.3;

/**
 * Resolves an unmatched scanned/imported line into a catalog product (spec §5).
 * Three explicit choices: new variant of an existing family, brand-new product,
 * or match-to-existing (learns an alias). Reuses ProductsService.create (parent
 * validation, per-parent name uniqueness, SKU auto-suggest, costing resolution).
 * The receive-stock-in-the-same-action wiring lives in the batch flow (Phase 5).
 */
@Injectable()
export class VariantResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly aliases: ProductAliasService,
  ) {}

  /**
   * New variant of an existing product (§5 choice 1). Inherits the parent family's
   * defaults — unit, price tiers, case size, category, costing method — so the
   * variant is a full product sharing family settings; caller supplies name + SKU.
   */
  async createVariant(dto: { parentProductId: string; variantName: string; sku?: string }) {
    const parent = await this.prisma.forTenant().product.findUnique({
      where: { id: dto.parentProductId },
    });
    if (!parent) throw new NotFoundException("Parent product not found");
    const name = (dto.variantName ?? "").trim();
    if (!name) throw new BadRequestException("A variant name is required.");
    return this.products.create({
      name,
      variantName: name,
      parentProductId: parent.id,
      sku: dto.sku,
      unit: parent.unit,
      pricePerUnit: parent.pricePerUnit.toString(),
      priceTier2: parent.priceTier2.toString(),
      priceTier3: parent.priceTier3.toString(),
      priceTier4: parent.priceTier4.toString(),
      priceTier5: parent.priceTier5.toString(),
      category: parent.category ?? undefined,
      unitsPerBox: parent.unitsPerBox ?? undefined,
      costingMethod: parent.costingMethod,
      standardCost: parent.standardCost != null ? parent.standardCost.toString() : undefined,
      isTobacco: parent.isTobacco,
    });
  }

  /**
   * Brand-new product from a scanned line (§5 choice 2): minimal name + SKU + cost,
   * sellable immediately at cost + default margin, flagged `detailsIncomplete`
   * until price/units are confirmed (surfaces under "Finish setup").
   */
  async createBrandNew(dto: { name: string; sku?: string; cost?: number; unit?: string }) {
    const name = (dto.name ?? "").trim();
    if (!name) throw new BadRequestException("A product name is required.");
    const cost = dto.cost && dto.cost > 0 ? dto.cost : 0;
    const listPrice = roundMoney(cost * (1 + DEFAULT_MARGIN));
    const created = await this.products.create({
      name,
      sku: dto.sku,
      unit: (dto.unit ?? "").trim() || "each",
      pricePerUnit: listPrice.toFixed(2),
      standardCost: cost > 0 ? cost.toFixed(4) : undefined,
    });
    // create() doesn't own the import-only flag; set it in a follow-up write.
    return this.prisma.forTenant().product.update({
      where: { id: created.id },
      data: { detailsIncomplete: true },
    });
  }

  /**
   * Match a scanned line to an existing product or expense category (§5 choice 3),
   * remembering the alias so the next scan auto-matches.
   */
  async matchExisting(dto: {
    supplierId?: string | null;
    rawText: string;
    productId?: string | null;
    expenseCategoryId?: string | null;
  }) {
    if (!dto.productId && !dto.expenseCategoryId) {
      throw new BadRequestException("A product or expense category is required to match.");
    }
    await this.aliases.learn(dto.supplierId, dto.rawText, {
      productId: dto.productId,
      expenseCategoryId: dto.expenseCategoryId,
    });
    return { ok: true };
  }

  /** Products awaiting "Finish setup" (brand-new, details not yet confirmed). */
  async listIncomplete() {
    return this.prisma.forTenant().product.findMany({
      where: { detailsIncomplete: true },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        pricePerUnit: true,
        standardCost: true,
        unitsPerBox: true,
        category: true,
        currentStock: true,
        createdAt: true,
      },
    });
  }

  /** Confirm a brand-new product's details and clear the incomplete flag. */
  async completeSetup(
    id: string,
    dto: { pricePerUnit?: number; unit?: string; unitsPerBox?: number; category?: string },
  ) {
    const product = await this.prisma.forTenant().product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");
    return this.prisma.forTenant().product.update({
      where: { id },
      data: {
        ...(dto.pricePerUnit !== undefined && { pricePerUnit: dto.pricePerUnit.toFixed(2) }),
        ...(dto.unit !== undefined && { unit: dto.unit }),
        ...(dto.unitsPerBox !== undefined && { unitsPerBox: dto.unitsPerBox }),
        ...(dto.category !== undefined && { category: dto.category }),
        detailsIncomplete: false,
      },
    });
  }
}
