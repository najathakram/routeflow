import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { packWordKey } from "../products/unit-pack-rules";
import { UNIT_NAME_EMPTY, UNIT_NAME_TOO_LONG } from "./dto/create-unit.dto";

export interface UnitDto {
  id: string;
  name: string;
  archivedAt: string | null;
  productCount: number;
}
export interface UnitUpdateResult {
  unit: UnitDto;
  /** DISTINCT products whose name for this unit was rewritten (0 for archive / restore). */
  productsUpdated: number;
}

interface RawUnitRow {
  id: string;
  name: string;
  archivedAt: Date | null;
  productCount: number;
}

const MAX_NAME = 30;
const MAX_COLLISION_PRODUCTS = 10;
const CHUNK = 5000;

/** The comparison form of a unit name: lower(trim(name)). */
export const unitNameKey = (name: string): string => name.trim().toLowerCase();

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new BadRequestException(UNIT_NAME_EMPTY);
  if (name.length > MAX_NAME) throw new BadRequestException(UNIT_NAME_TOO_LONG);
  return name;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

/**
 * Tenant-wide unit NAMES ("Case", "Box", ...). A names list, never a math source: order, invoice and
 * return lines snapshot their unit words as text and never reference a TenantUnit, so renaming here
 * rewrites product labels only. Tenant comes from the JWT context, never from the body. There is no
 * delete: archive hides a unit from pickers and leaves every product row alone.
 */
@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Writes and reads need a tenant: SUPER_ADMIN's unscoped client would cross tenants. */
  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  private toDto(r: RawUnitRow): UnitDto {
    return {
      id: r.id,
      name: r.name,
      archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
      productCount: Number(r.productCount),
    };
  }

  /**
   * ONE query: each unit with the DISTINCT products that use its name, across ProductUnit.label (via
   * tenantUnitId) and Product.baseUnitLabel / packLabel / unit (matched by nameKey). UNION dedups a
   * product that uses the name in several places.
   */
  private async rows(
    tenantId: string,
    opts: { includeArchived: boolean; id?: string },
  ): Promise<UnitDto[]> {
    const archivedFilter = opts.includeArchived
      ? Prisma.empty
      : Prisma.sql`AND u."archivedAt" IS NULL`;
    const idFilter = opts.id ? Prisma.sql`AND u."id" = ${opts.id}` : Prisma.empty;
    const raw = await this.prisma.$queryRaw<RawUnitRow[]>(Prisma.sql`
      SELECT u."id", u."name", u."archivedAt",
        (SELECT COUNT(*)::int FROM (
          SELECT pu."productId" AS pid FROM "ProductUnit" pu WHERE pu."tenantUnitId" = u."id"
          UNION
          SELECT p."id" FROM "Product" p
          WHERE p."tenantId" = u."tenantId"
            AND (lower(btrim(p."baseUnitLabel")) = u."nameKey"
              OR lower(btrim(p."packLabel")) = u."nameKey"
              OR lower(btrim(p."unit")) = u."nameKey")
        ) used) AS "productCount"
      FROM "TenantUnit" u
      WHERE u."tenantId" = ${tenantId} ${archivedFilter} ${idFilter}
      ORDER BY lower(u."name"), u."id"`);
    return raw.map((r) => this.toDto(r));
  }

  async list(includeArchived: boolean): Promise<UnitDto[]> {
    const tenantId = this.requireTenant();
    return this.rows(tenantId, { includeArchived });
  }

  private async oneRow(tenantId: string, id: string): Promise<UnitDto> {
    const [row] = await this.rows(tenantId, { includeArchived: true, id });
    if (!row) throw new NotFoundException("Unit not found");
    return row;
  }

  /**
   * Idempotent by nameKey. A name matching an ARCHIVED unit restores that row (same id) and audits
   * the restore (owner ruling R4). Two concurrent adds end as one row (the unique index decides).
   */
  async create(dto: { name: string }, user: JwtPayload): Promise<UnitDto> {
    const tenantId = this.requireTenant();
    const name = cleanName(dto.name);
    const nameKey = unitNameKey(name);
    const db = this.prisma.forTenant();

    let existing = await db.tenantUnit.findFirst({ where: { tenantId, nameKey } });
    if (!existing) {
      try {
        const created = await db.tenantUnit.create({ data: { tenantId, name, nameKey } });
        return this.oneRow(tenantId, created.id);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        existing = await db.tenantUnit.findFirst({ where: { tenantId, nameKey } });
        if (!existing) throw e;
      }
    }
    if (existing.archivedAt) {
      await db.tenantUnit.updateMany({
        where: { id: existing.id, tenantId },
        data: { archivedAt: null },
      });
      const unit = await this.oneRow(tenantId, existing.id);
      await this.audit.log({
        tenantId,
        userId: user.sub,
        action: "tenant_unit.restored",
        entityType: "TenantUnit",
        entityId: existing.id,
        meta: { name: existing.name, productCount: unit.productCount, via: "add" },
      });
      return unit;
    }
    return this.oneRow(tenantId, existing.id);
  }

  async update(
    id: string,
    dto: { name?: string; archived?: boolean },
    user: JwtPayload,
  ): Promise<UnitUpdateResult> {
    const tenantId = this.requireTenant();
    const hasName = dto.name !== undefined;
    const hasArchived = dto.archived !== undefined;
    if (hasName === hasArchived) {
      throw new BadRequestException("Send either a new name or archived, not both.");
    }
    if (hasName) return this.rename(tenantId, id, cleanName(dto.name), user);
    return this.setArchived(tenantId, id, dto.archived === true, user);
  }

  private async setArchived(
    tenantId: string,
    id: string,
    archived: boolean,
    user: JwtPayload,
  ): Promise<UnitUpdateResult> {
    const db = this.prisma.forTenant();
    const existing = await db.tenantUnit.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Unit not found");
    const { count } = await db.tenantUnit.updateMany({
      where: { id, tenantId },
      data: { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null },
    });
    if (count === 0) throw new NotFoundException("Unit not found");
    const unit = await this.oneRow(tenantId, id);
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: archived ? "tenant_unit.archived" : "tenant_unit.restored",
      entityType: "TenantUnit",
      entityId: id,
      meta: { name: existing.name, productCount: unit.productCount },
    });
    return { unit, productsUpdated: 0 };
  }

  private async rename(
    tenantId: string,
    id: string,
    newName: string,
    user: JwtPayload,
  ): Promise<UnitUpdateResult> {
    const newKey = unitNameKey(newName);
    const done = await this.prisma.tenantTransaction(async (tx) => {
      const unit = await tx.tenantUnit.findFirst({ where: { id, tenantId } });
      if (!unit) throw new NotFoundException("Unit not found");
      const oldKey: string = unit.nameKey;

      // Another row (archived or not) already holds the name. A case-only change of itself is fine.
      const clash = await tx.tenantUnit.findFirst({
        where: { tenantId, nameKey: newKey, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw this.nameTaken(newName);

      // Products that use the old name: via a linked level, or base / pack / unit text (by nameKey).
      const linked: Array<{ id: string; productId: string }> = await tx.productUnit.findMany({
        where: { tenantId, tenantUnitId: id },
        select: { id: true, productId: true },
      });
      const levelProductIds = [...new Set(linked.map((l) => l.productId))];
      const products: Array<{
        id: string;
        name: string;
        baseUnitLabel: string | null;
        packLabel: string | null;
        unit: string | null;
      }> = await tx.product.findMany({
        where: {
          tenantId,
          OR: [
            { id: { in: levelProductIds } },
            { baseUnitLabel: { contains: oldKey, mode: "insensitive" } },
            { packLabel: { contains: oldKey, mode: "insensitive" } },
            { unit: { contains: oldKey, mode: "insensitive" } },
          ],
        },
        select: { id: true, name: true, baseUnitLabel: true, packLabel: true, unit: true },
      });

      const matches = (v: string | null) => v != null && unitNameKey(v) === oldKey;
      const levelRows: Array<{ productId: string; label: string; tenantUnitId: string | null }> =
        [];
      for (const part of chunks(products.map((p) => p.id))) {
        levelRows.push(
          ...(await tx.productUnit.findMany({
            where: { productId: { in: part } },
            select: { productId: true, label: true, tenantUnitId: true },
          })),
        );
      }

      // Refuse the WHOLE rename when, in any product, it would leave two labels equal: the (productId,
      // label) unique, base/pack sharing a label with a level, or a level sharing the PACK word
      // (`Product.unit`, "Box" when blank) which the ladder resolves first and so would make the
      // level unreachable (mirrors unit-pack-rules `assertPackKeepsLevelsValid`).
      const colliding = products.filter((p) => {
        const mine = levelRows.filter((l) => l.productId === p.id);
        const renamed = mine.filter((l) => l.tenantUnitId === id);
        // Several levels of one product linked to this unit ("Case" + "case") would all take the new
        // name and break the (productId,label) unique: refuse, the operator fixes the product.
        if (renamed.length > 1) return true;
        if (newKey === oldKey) return false;
        const others: string[] = mine
          .filter((l) => l.tenantUnitId !== id)
          .map((l) => unitNameKey(l.label));
        if (p.baseUnitLabel && !matches(p.baseUnitLabel)) others.push(unitNameKey(p.baseUnitLabel));
        if (p.packLabel && !matches(p.packLabel)) others.push(unitNameKey(p.packLabel));
        // A pack word that renames with this unit is the renamed one, not a clash.
        if (renamed.length > 0 && !matches(p.unit)) others.push(packWordKey(p.unit));
        return others.includes(newKey);
      });
      if (colliding.length > 0) {
        throw new ConflictException({
          code: API_ERROR_CODES.UNIT_RENAME_COLLISION,
          message: `Can't rename to ${newName}: some products already have a ${newName}.`,
          products: colliding
            .slice(0, MAX_COLLISION_PRODUCTS)
            .map((p) => ({ id: p.id, name: p.name })),
          total: colliding.length,
        });
      }

      const baseIds = products.filter((p) => matches(p.baseUnitLabel)).map((p) => p.id);
      const packIds = products.filter((p) => matches(p.packLabel)).map((p) => p.id);
      const unitIds = products.filter((p) => matches(p.unit)).map((p) => p.id);

      let updated;
      try {
        updated = await tx.tenantUnit.update({
          where: { id },
          data: { name: newName, nameKey: newKey },
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw this.nameTaken(newName);
        throw e;
      }
      await tx.productUnit.updateMany({
        where: { tenantId, tenantUnitId: id },
        data: { label: newName },
      });
      // Literal `data` on purpose: the Product-write tripwires reject variable or spread data.
      for (const part of chunks(baseIds)) {
        await tx.product.updateMany({
          where: { tenantId, id: { in: part } },
          data: { baseUnitLabel: newName },
        });
      }
      for (const part of chunks(packIds)) {
        await tx.product.updateMany({
          where: { tenantId, id: { in: part } },
          data: { packLabel: newName },
        });
      }
      for (const part of chunks(unitIds)) {
        await tx.product.updateMany({
          where: { tenantId, id: { in: part } },
          data: { unit: newName },
        });
      }

      const distinct = new Set<string>([...levelProductIds, ...baseIds, ...packIds, ...unitIds]);
      return { before: unit.name as string, updated, productsUpdated: distinct.size };
    });

    // The audit row is non-transactional by design: written only once the rename has committed.
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "tenant_unit.renamed",
      entityType: "TenantUnit",
      entityId: id,
      meta: { from: done.before, to: newName, productsUpdated: done.productsUpdated },
    });
    return {
      unit: {
        id,
        name: done.updated.name,
        archivedAt: done.updated.archivedAt
          ? new Date(done.updated.archivedAt).toISOString()
          : null,
        productCount: done.productsUpdated,
      },
      productsUpdated: done.productsUpdated,
    };
  }

  private nameTaken(name: string): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.UNIT_NAME_TAKEN,
      message: `You already have a unit called ${name}.`,
    });
  }
}
