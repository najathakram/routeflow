import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PromotionScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePromotionDto } from "./dto/create-promotion.dto";
import { UpdatePromotionDto } from "./dto/update-promotion.dto";

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

  async create(dto: CreatePromotionDto) {
    this.validateRule(dto);
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
    await this.findOne(id); // tenant-scoped existence + 404
    this.validateRule(dto);
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
