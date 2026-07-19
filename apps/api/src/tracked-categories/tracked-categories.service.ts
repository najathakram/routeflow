import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateTrackedCategoryDto } from "./dto/create-tracked-category.dto";
import { UpdateTrackedCategoryDto } from "./dto/update-tracked-category.dto";
import { ListTrackedCategoriesDto } from "./dto/list-tracked-categories.dto";
import { CreateSubcategoryDto } from "./dto/create-subcategory.dto";
import { UpdateSubcategoryDto } from "./dto/update-subcategory.dto";

/**
 * CRUD for tenant-defined regulated ("tracked") categories — the generic system
 * that generalizes the hardcoded tobacco flag (Phase 4 W2). Tobacco is seed row
 * #1, created by the W1 backfill; it is edited/created/toggled here like any other
 * category. All access is tenant-scoped via `prisma.forTenant()`.
 */
// Every response carries `productCount` (assigned products) so the shape is
// identical across the list / detail / mutation endpoints.
const WITH_COUNT = { _count: { select: { products: true } } } as const;

type WithCount<T> = T & { _count: { products: number } };

@Injectable()
export class TrackedCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize<T extends object>(row: WithCount<T>) {
    const { _count, ...rest } = row;
    return { ...rest, productCount: _count.products };
  }

  async findAll(query: ListTrackedCategoriesDto) {
    const where: Prisma.TrackedCategoryWhereInput = {};
    if (query.search) where.name = { contains: query.search, mode: "insensitive" };
    if (query.active !== undefined) where.active = query.active;

    const rows = await this.prisma.forTenant().trackedCategory.findMany({
      where,
      orderBy: { name: "asc" },
      include: WITH_COUNT,
    });
    return rows.map((r) => this.serialize(r));
  }

  async findOne(id: string) {
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id },
      include: WITH_COUNT,
    });
    if (!cat) throw new NotFoundException("Tracked category not found");
    return this.serialize(cat);
  }

  /**
   * RF-4: tax-inclusive category pricing (`priceIncludesTax=true`) is NOT yet
   * supported for the per-category tax fold — computeCategoryTax returns the tax
   * ALREADY EMBEDDED in the price, which must not be added on top of the total (it
   * would over-charge). Reject the config so no order/invoice ever books it; the
   * common add-on case (priceIncludesTax=false) is fully supported. Remove this once
   * the totals subtract the embedded portion.
   */
  private assertSupportedTaxConfig(
    taxType: string | null | undefined,
    rate: unknown,
    priceIncludesTax: boolean | null | undefined,
  ): void {
    if (priceIncludesTax && taxType && taxType !== "NONE" && Number(rate) > 0) {
      throw new BadRequestException(
        "Tax-inclusive category pricing (priceIncludesTax) is not yet supported for per-category tax. Set priceIncludesTax to false.",
      );
    }
  }

  async create(dto: CreateTrackedCategoryDto) {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("A tenant context is required to create a category.");
    }
    this.assertSupportedTaxConfig(dto.taxType, dto.rate, dto.priceIncludesTax);
    try {
      const row = await this.prisma
        .forTenant()
        .trackedCategory.create({ data: { ...this.toData(dto), tenantId }, include: WITH_COUNT });
      return this.serialize(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A category named "${dto.name}" already exists.`);
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateTrackedCategoryDto) {
    const existing = await this.findOne(id);
    // Validate the MERGED config so a partial update (e.g. flipping only
    // priceIncludesTax) is checked against the row's existing taxType/rate.
    this.assertSupportedTaxConfig(
      dto.taxType ?? (existing as any).taxType,
      dto.rate ?? (existing as any).rate,
      dto.priceIncludesTax ?? (existing as any).priceIncludesTax,
    );
    try {
      const row = await this.prisma
        .forTenant()
        .trackedCategory.update({ where: { id }, data: this.toData(dto), include: WITH_COUNT });
      return this.serialize(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A category named "${dto.name ?? ""}" already exists.`);
      }
      throw e;
    }
  }

  /**
   * Normalize a DTO into Prisma data. `appliesScope` is a free-form JSON object
   * in the DTO but Prisma's Json input type is stricter, so cast it explicitly
   * (omitted when the DTO didn't provide it).
   */
  private toData<T extends CreateTrackedCategoryDto | UpdateTrackedCategoryDto>(dto: T) {
    const { appliesScope, ...rest } = dto;
    return {
      ...rest,
      ...(appliesScope !== undefined
        ? { appliesScope: appliesScope as Prisma.InputJsonValue }
        : {}),
    };
  }

  /** Flip active on/off. Deactivation keeps historic sales/ledger data intact. */
  async toggle(id: string) {
    const cat = await this.findOne(id);
    const row = await this.prisma.forTenant().trackedCategory.update({
      where: { id },
      data: { active: !cat.active },
      include: WITH_COUNT,
    });
    return this.serialize(row);
  }

  /**
   * Bulk-assign products to this category (one category max per product — this
   * overwrites any prior assignment). Sets ONLY the new generic
   * `Product.trackedCategoryId` pointer. During the shadow-column period the
   * legacy `isTobacco` flag stays owned by the product flow (+ its addon gate),
   * and tobacco reports still key off `isTobacco`, so they are unaffected here
   * until they are re-pointed to the category in a later release.
   */
  async assignProducts(id: string, productIds: string[]) {
    await this.findOne(id);
    // Movers/new assignees get the section AND a cleared subcategory (a
    // subcategory's parent must equal the product's section — leaving the old
    // one behind strands an invariant violation that 400s later product
    // updates). Rows already in this section are untouched.
    const { count } = await this.prisma.forTenant().product.updateMany({
      where: { id: { in: productIds }, NOT: { trackedCategoryId: id } },
      data: { trackedCategoryId: id, trackedSubcategoryId: null },
    });
    return { assigned: count };
  }

  /** Remove the given products from this category (revert to standard). */
  async unassignProducts(id: string, productIds: string[]) {
    await this.findOne(id);
    const { count } = await this.prisma.forTenant().product.updateMany({
      where: { id: { in: productIds }, trackedCategoryId: id },
      data: { trackedCategoryId: null, trackedSubcategoryId: null },
    });
    return { unassigned: count };
  }

  // ── Subcategories (classification children of a section) ──────────────────
  // Reporting/classification only — no license/tax/invoice semantics (those stay
  // on the parent section). Nested under a section so listing is section-scoped.

  private serializeSub<T extends object>(row: WithCount<T>) {
    const { _count, ...rest } = row;
    return { ...rest, productCount: _count.products };
  }

  /** Load a subcategory and assert it belongs to the given section (+ tenant). */
  private async getSubcategoryOrThrow(categoryId: string, subId: string) {
    const sub = await this.prisma
      .forTenant()
      .trackedSubcategory.findUnique({ where: { id: subId }, include: WITH_COUNT });
    if (!sub || sub.trackedCategoryId !== categoryId) {
      throw new NotFoundException("Subcategory not found");
    }
    return sub;
  }

  /** List a section's subcategories (all — the manager toggles inactive ones). */
  async listSubcategories(categoryId: string) {
    await this.findOne(categoryId);
    const rows = await this.prisma.forTenant().trackedSubcategory.findMany({
      where: { trackedCategoryId: categoryId },
      orderBy: { name: "asc" },
      include: WITH_COUNT,
    });
    return rows.map((r) => this.serializeSub(r));
  }

  async createSubcategory(categoryId: string, dto: CreateSubcategoryDto) {
    await this.findOne(categoryId);
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("A tenant context is required to create a subcategory.");
    }
    try {
      const row = await this.prisma.forTenant().trackedSubcategory.create({
        data: {
          name: dto.name,
          active: dto.active ?? true,
          trackedCategoryId: categoryId,
          tenantId,
        },
        include: WITH_COUNT,
      });
      return this.serializeSub(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(
          `A subcategory named "${dto.name}" already exists in this section.`,
        );
      }
      throw e;
    }
  }

  async updateSubcategory(categoryId: string, subId: string, dto: UpdateSubcategoryDto) {
    await this.getSubcategoryOrThrow(categoryId, subId);
    try {
      const row = await this.prisma.forTenant().trackedSubcategory.update({
        where: { id: subId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
        include: WITH_COUNT,
      });
      return this.serializeSub(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(
          `A subcategory named "${dto.name ?? ""}" already exists in this section.`,
        );
      }
      throw e;
    }
  }

  /** Flip active on/off. Deactivation keeps historic product tags intact. */
  async toggleSubcategory(categoryId: string, subId: string) {
    const sub = await this.getSubcategoryOrThrow(categoryId, subId);
    const row = await this.prisma.forTenant().trackedSubcategory.update({
      where: { id: subId },
      data: { active: !sub.active },
      include: WITH_COUNT,
    });
    return this.serializeSub(row);
  }
}
