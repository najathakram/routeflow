import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PromotionScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  ruleCanZeroPrice,
  scanPromotionZeroPrice,
  zeroPriceWarning,
  type PromotionRule,
} from "../common/pricing";
import { CreatePromotionDto } from "./dto/create-promotion.dto";
import { UpdatePromotionDto } from "./dto/update-promotion.dto";

/**
 * The stored promotion fields the zero-price guard reads back. `value` is a Prisma
 * `Decimal` at runtime — kept `unknown` here so the guard has to go through
 * `Number()` (the money helpers coerce) instead of assuming a JS number.
 *
 * `type`/`scope` stay plain strings rather than borrowing the pricing unions: the
 * Prisma enums grow independently (a new promotion type lands in the schema before
 * the pricing mirrors model it), and the guard degrades safely when they do —
 * `promoNetPrice` returns null for a type it does not model, so an unmodelled rule
 * is simply never flagged instead of failing to compile here.
 */
interface StoredPromotion {
  id: string;
  type: string;
  value: unknown;
  minQty: number | null;
  scope: string;
  category: string | null;
  products?: Array<{ productId: string }>;
}

/**
 * Phase 5 (P5-01): tenant-managed merchandising promotions. This service owns CRUD +
 * the buyer-facing "active promotions" read. It does NOT price anything — the pricing
 * engine (pricing.ts) consumes a promotion's typed rule at cart time. Tenant-scoped
 * via forTenant(); the join set (PromotionProduct) is replaced atomically on write.
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  private validateRule(dto: Partial<CreatePromotionDto>) {
    if (dto.type === "QTY_BREAK" && !(dto.minQty && dto.minQty > 0)) {
      throw new BadRequestException("QTY_BREAK promotions require a minQty >= 1");
    }
    // BUY_N_GET_M ("buy 5, get the 6th free") reuses minQty/value as N/M — no
    // dedicated columns. Both must be positive integers: a fractional or <1 N or M
    // makes floor(qtyUnits / (N+M)) * M nonsensical (divide-by-tiny-N or no-op M).
    if (dto.type === "BUY_N_GET_M") {
      if (!(Number.isInteger(dto.minQty) && (dto.minQty as number) >= 1)) {
        throw new BadRequestException(
          "Buy N Get M promotions require an integer buy quantity (minQty) >= 1",
        );
      }
      if (!(Number.isInteger(dto.value) && (dto.value as number) >= 1)) {
        throw new BadRequestException(
          "Buy N Get M promotions require an integer free quantity (value) >= 1",
        );
      }
    }
    if (dto.scope === PromotionScope.CATEGORY && !dto.category) {
      throw new BadRequestException("CATEGORY-scoped promotions require a category");
    }
    if (
      dto.scope === PromotionScope.PRODUCTS &&
      !(Array.isArray(dto.productIds) && dto.productIds.length > 0)
    ) {
      throw new BadRequestException("PRODUCTS-scoped promotions require at least one productId");
    }
    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) {
      throw new BadRequestException("endsAt must be after startsAt");
    }
  }

  /**
   * The rule a write would LEAVE in the database. A PATCH only carries the fields
   * it changes, so the zero-price guard has to judge the merged rule and never the
   * patch alone — flipping a live PERCENT promo to `{type: FIXED, value: 35}`
   * arrives with no scope at all, yet inherits the existing ALL scope.
   */
  private mergedRule(dto: Partial<CreatePromotionDto>, existing?: StoredPromotion): PromotionRule {
    return {
      id: existing?.id ?? "draft",
      type: (dto.type ?? existing?.type) as PromotionRule["type"],
      value: Number(dto.value ?? existing?.value ?? 0),
      minQty: dto.minQty ?? existing?.minQty ?? null,
      scope: (dto.scope ?? existing?.scope) as PromotionRule["scope"],
      category: dto.category ?? existing?.category ?? null,
      productIds: dto.productIds ?? existing?.products?.map((p) => p.productId) ?? [],
    };
  }

  /**
   * Refuse a rule that would put in-scope products on the buyer portal — and on the
   * invoice those orders bill — at $0.00. `promoNetPrice` floors the net at 0, so a
   * FIXED amount larger than a product's selling-unit price sells it for nothing
   * (2026-08-20: an ALL-scoped "$35 off" zeroed 699 of a tenant's 1,767 products).
   *
   * `allowZeroPrice` is the operator's explicit "yes, I mean it" — a confirmation
   * flag only, never persisted. Ordinary rules never touch the catalog: the shape
   * check short-circuits everything except FIXED and a full 100% off.
   */
  private async assertNoZeroPricedProducts(
    dto: Partial<CreatePromotionDto>,
    existing?: StoredPromotion,
  ) {
    if (dto.allowZeroPrice) return;
    const rule = this.mergedRule(dto, existing);
    if (!ruleCanZeroPrice(rule)) return;

    // Narrow the scan in SQL where the scope allows it; scanPromotionZeroPrice
    // re-checks the scope regardless, so these clauses are an optimisation only.
    const where: Record<string, unknown> = { isActive: true };
    if (rule.scope === PromotionScope.CATEGORY) where.category = rule.category ?? null;
    else if (rule.scope === PromotionScope.PRODUCTS) where.id = { in: rule.productIds ?? [] };

    const products = await this.prisma.forTenant().product.findMany({
      where,
      select: { id: true, name: true, category: true, pricePerUnit: true },
    });
    const impact = scanPromotionZeroPrice(
      products.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        price: Number(p.pricePerUnit),
      })),
      rule,
    );
    if (impact.count === 0) return;

    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      code: "PROMOTION_ZERO_PRICE",
      message: `${zeroPriceWarning(impact)} Lower the amount, narrow the scope, or resend with allowZeroPrice: true to confirm.`,
      zeroPriceCount: impact.count,
      inScopeCount: impact.inScope,
      examples: impact.examples,
    });
  }

  async create(dto: CreatePromotionDto) {
    this.validateRule(dto);
    await this.assertNoZeroPricedProducts(dto);
    const tenantId = this.prisma.getTenantId();
    return this.prisma.tenantTransaction(async (tx: any) => {
      const promo = await tx.promotion.create({
        data: {
          name: dto.name,
          bannerText: dto.bannerText,
          type: dto.type,
          value: dto.value,
          minQty: dto.minQty ?? null,
          scope: dto.scope,
          category: dto.scope === PromotionScope.CATEGORY ? dto.category : null,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          isActive: dto.isActive ?? true,
        },
      });
      if (dto.scope === PromotionScope.PRODUCTS && dto.productIds && tenantId) {
        await tx.promotionProduct.createMany({
          data: dto.productIds.map((productId) => ({ promotionId: promo.id, productId, tenantId })),
        });
      }
      return this.findOne(promo.id, tx);
    });
  }

  async findAll() {
    return this.prisma.forTenant().promotion.findMany({
      include: { products: { select: { productId: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string, db = this.prisma.forTenant()) {
    const promo = await db.promotion.findUnique({
      where: { id },
      include: { products: { select: { productId: true } } },
    });
    if (!promo) throw new NotFoundException("Promotion not found");
    return promo;
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const existing: StoredPromotion = await this.findOne(id); // tenant-scoped existence + 404
    this.validateRule(dto);
    await this.assertNoZeroPricedProducts(dto, existing);
    const tenantId = this.prisma.getTenantId();
    return this.prisma.tenantTransaction(async (tx: any) => {
      await tx.promotion.update({
        where: { id },
        data: {
          name: dto.name,
          bannerText: dto.bannerText,
          type: dto.type,
          value: dto.value,
          minQty: dto.minQty,
          scope: dto.scope,
          category: dto.scope === PromotionScope.CATEGORY ? dto.category : dto.category,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
          isActive: dto.isActive,
        },
      });
      // Replace the explicit product set only when productIds was supplied.
      if (dto.productIds && tenantId) {
        await tx.promotionProduct.deleteMany({ where: { promotionId: id } });
        if (dto.productIds.length > 0) {
          await tx.promotionProduct.createMany({
            data: dto.productIds.map((productId) => ({ promotionId: id, productId, tenantId })),
          });
        }
      }
      return this.findOne(id, tx);
    });
  }

  /** Enable/disable without editing the rule. */
  async setActive(id: string, isActive: boolean) {
    await this.findOne(id);
    await this.prisma.forTenant().promotion.update({ where: { id }, data: { isActive } });
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.forTenant().promotion.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Promotions that are ACTIVE and in-window right now — the buyer-facing read. Cascades
   * of PromotionProduct come back as `productIds` so the client (and pricing) can match.
   */
  async activeForCatalog(now: Date = new Date()) {
    const promos = await this.prisma.forTenant().promotion.findMany({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
      include: { products: { select: { productId: true } } },
      orderBy: { endsAt: "asc" },
    });
    return promos.map((p: any) => ({
      id: p.id,
      name: p.name,
      bannerText: p.bannerText,
      type: p.type,
      value: Number(p.value),
      minQty: p.minQty,
      scope: p.scope,
      category: p.category,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      productIds: p.products.map((pp: any) => pp.productId),
    }));
  }
}
