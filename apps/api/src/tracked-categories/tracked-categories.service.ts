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

/**
 * CRUD for tenant-defined regulated ("tracked") categories — the generic system
 * that generalizes the hardcoded tobacco flag (Phase 4 W2). Tobacco is seed row
 * #1, created by the W1 backfill; it is edited/created/toggled here like any other
 * category. All access is tenant-scoped via `prisma.forTenant()`.
 */
@Injectable()
export class TrackedCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListTrackedCategoriesDto) {
    const where: Prisma.TrackedCategoryWhereInput = {};
    if (query.search) where.name = { contains: query.search, mode: "insensitive" };
    if (query.active !== undefined) where.active = query.active;

    const rows = await this.prisma.forTenant().trackedCategory.findMany({
      where,
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
  }

  async findOne(id: string) {
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!cat) throw new NotFoundException("Tracked category not found");
    const { _count, ...rest } = cat;
    return { ...rest, productCount: _count.products };
  }

  async create(dto: CreateTrackedCategoryDto) {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("A tenant context is required to create a category.");
    }
    try {
      return await this.prisma
        .forTenant()
        .trackedCategory.create({ data: { ...this.toData(dto), tenantId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A category named "${dto.name}" already exists.`);
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateTrackedCategoryDto) {
    await this.findOne(id);
    try {
      return await this.prisma
        .forTenant()
        .trackedCategory.update({ where: { id }, data: this.toData(dto) });
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
    return this.prisma.forTenant().trackedCategory.update({
      where: { id },
      data: { active: !cat.active },
    });
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
    const { count } = await this.prisma.forTenant().product.updateMany({
      where: { id: { in: productIds } },
      data: { trackedCategoryId: id },
    });
    return { assigned: count };
  }

  /** Remove the given products from this category (revert to standard). */
  async unassignProducts(id: string, productIds: string[]) {
    await this.findOne(id);
    const { count } = await this.prisma.forTenant().product.updateMany({
      where: { id: { in: productIds }, trackedCategoryId: id },
      data: { trackedCategoryId: null },
    });
    return { unassigned: count };
  }
}
