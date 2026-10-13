import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { LabelCategoryDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateProductCategoryDto } from "./dto/create-product-category.dto";
import { UpdateProductCategoryDto } from "./dto/update-product-category.dto";
import { assertSafeCategoryName } from "../common/text-cell-guards";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  findLabelNameCollision,
  LabelLockTimeoutError,
  lockTenantLabelNames,
} from "./label-writer";

/** 409 LABEL_NAME_TAKEN naming the existing label (the web shows fixed copy; the body carries the name). */
function labelNameTaken(existing: { id: string; name: string }): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.LABEL_NAME_TAKEN,
    message: `A label named "${existing.name}" already exists.`,
    existingLabel: { id: existing.id, name: existing.name },
  });
}

/**
 * Tenant-defined restriction categories ("Alcohol", "THC") — the label vocabulary the selling-
 * restrictions engine matches against. Deliberately separate from TrackedCategory (compliance
 * reporting) and from the free-text `Product.category`. Reads are OPERATOR; writes TENANT_ADMIN
 * (a label decides what a ban covers, so it is as sensitive as the rule itself).
 */
@Injectable()
export class ProductCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Writes need a tenant: SUPER_ADMIN's unscoped client would otherwise cross tenants. */
  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  private select(now: Date) {
    return {
      id: true,
      name: true,
      archivedAt: true,
      createdAt: true,
      _count: {
        select: {
          labels: { where: { mode: "INCLUDE" as const } },
          sellingRestrictions: { where: activeRuleWhere(now) },
        },
      },
    } satisfies Prisma.ProductCategorySelect;
  }

  private toDto(
    row: Prisma.ProductCategoryGetPayload<{
      select: ReturnType<ProductCategoriesService["select"]>;
    }>,
  ): LabelCategoryDto {
    return {
      id: row.id,
      name: row.name,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      productCount: row._count.labels,
      activeRestrictionCount: row._count.sellingRestrictions,
    };
  }

  async list(includeArchived = false): Promise<LabelCategoryDto[]> {
    this.requireTenant(); // SUPER_ADMIN's unscoped client would list every tenant's categories together
    const rows = await this.prisma.forTenant().productCategory.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { name: "asc" },
      select: this.select(new Date()),
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(dto: CreateProductCategoryDto, user: JwtPayload): Promise<LabelCategoryDto> {
    const tenantId = this.requireTenant();
    assertSafeCategoryName(dto.name); // B983: refuse a formula-led name before any write or audit
    try {
      // One NAME per key (labelNameKey: case/space-insensitive), checked under the per-tenant names lock the
      // backfill script also takes, so two creates (or a create during a backfill) cannot both pass.
      const row = await this.prisma.tenantTransaction(async (tx) => {
        await this.lockNames(tx, tenantId);
        const clash = await findLabelNameCollision(tx, tenantId, dto.name);
        if (clash) throw labelNameTaken(clash);
        return tx.productCategory.create({
          data: { name: dto.name, tenantId },
          select: this.select(new Date()),
        });
      });
      await this.audit.log({
        tenantId,
        userId: user.sub,
        action: "product_category.created",
        entityType: "ProductCategory",
        entityId: row.id,
        meta: { name: dto.name },
      });
      return this.toDto(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw labelNameTaken({ id: "", name: dto.name });
      }
      throw e;
    }
  }

  /** The per-tenant label-names lock; a busy lock (e.g. a backfill run) is a clear 409, not a hang. */
  private async lockNames(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    try {
      await lockTenantLabelNames(tx, tenantId);
    } catch (e) {
      if (e instanceof LabelLockTimeoutError) throw new ConflictException(e.message);
      throw e;
    }
  }

  async update(
    id: string,
    dto: UpdateProductCategoryDto,
    user: JwtPayload,
  ): Promise<LabelCategoryDto> {
    const tenantId = this.requireTenant();
    const db = this.prisma.forTenant();
    const now = new Date();
    const existing = await db.productCategory.findFirst({
      where: { id },
      select: this.select(now),
    });
    if (!existing) throw new NotFoundException("Category not found");
    if (dto.name !== undefined) assertSafeCategoryName(dto.name, existing.name); // B983: change-only

    const archiving = dto.archived === true && !existing.archivedAt;
    const data: Prisma.ProductCategoryUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.archived !== undefined) {
      data.archivedAt = dto.archived ? (existing.archivedAt ?? now) : null;
    }
    if (Object.keys(data).length === 0) return this.toDto(existing);

    // Archiving hides the category from pickers while its labels stay in force — so refuse
    // while a rule in force (the engine's own `activeRuleWhere`, never a local copy) still targets
    // it; lift the rule first (an explicit, audited step). The guard lives IN the write's WHERE so a
    // rule created between a pre-read and the write cannot slip past it.
    const where: Prisma.ProductCategoryWhereInput = {
      id,
      ...(archiving ? { sellingRestrictions: { none: activeRuleWhere(now) } } : {}),
    };
    let count: number;
    try {
      if (dto.name !== undefined) {
        // A rename: the key check (itself excluded, so a case-only change is fine) and the write under the
        // per-tenant names lock.
        const name = dto.name;
        ({ count } = await this.prisma.tenantTransaction(async (tx) => {
          await this.lockNames(tx, tenantId);
          const clash = await findLabelNameCollision(tx, tenantId, name, id);
          if (clash) throw labelNameTaken(clash);
          return tx.productCategory.updateMany({ where, data });
        }));
      } else {
        ({ count } = await db.productCategory.updateMany({ where, data }));
      }
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw labelNameTaken({ id: "", name: dto.name ?? "" });
      }
      throw e;
    }
    if (count === 0) {
      // Distinguish "a rule is in force" from "the row vanished between the read and the write".
      const stillThere = await db.productCategory.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!stillThere) throw new NotFoundException("Category not found");
      if (archiving) {
        throw new ConflictException(
          "This category has active selling restrictions. Lift them before archiving it.",
        );
      }
      throw new NotFoundException("Category not found");
    }
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "product_category.updated",
      entityType: "ProductCategory",
      entityId: id,
      meta: { from: { name: existing.name, archived: !!existing.archivedAt }, to: dto },
    });
    const fresh = await db.productCategory.findFirst({ where: { id }, select: this.select(now) });
    if (!fresh) throw new NotFoundException("Category not found");
    return this.toDto(fresh);
  }
}
