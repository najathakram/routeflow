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
import { packFactorOf, packWordKey } from "../products/unit-pack-rules";
import { UNIT_NAME_EMPTY, UNIT_NAME_IS_PIECE, UNIT_NAME_TOO_LONG } from "./dto/create-unit.dto";
import { isPieceSynonym, unitNameKey } from "./piece-words";
import { lockTenantUnits } from "./tenant-units-lock";
import { sqlKeyOf } from "./unit-name-sql";

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

export const MAX_UNIT_NAME_LENGTH = 30;
const MAX_COLLISION_PRODUCTS = 10;
/** Why a product refuses a rename; `MIXED` is the body reason when several causes apply. */
type CollisionReason = "NAME" | "DUPLICATE_LEVELS" | "LINES_AT_OTHER_SIZE";
/**
 * A rename reads and relabels every product of the tenant that uses the unit, in CHUNK-sized writes,
 * and first waits for the tenant units lock behind in-flight pack edits (milliseconds each). Sized for
 * a catalog of tens of thousands of products: 60 s for the work (Prisma's default 5 s would abort a
 * large tenant mid-relabel and roll everything back), 10 s to get a connection from a busy pool.
 */
const RENAME_TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;
const CHUNK = 5000;

const sqlKey = (column: "baseUnitLabel" | "packLabel" | "unit") =>
  sqlKeyOf(Prisma.sql`p.${Prisma.raw(`"${column}"`)}`);

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!name) throw new BadRequestException(UNIT_NAME_EMPTY);
  if (name.length > MAX_UNIT_NAME_LENGTH) throw new BadRequestException(UNIT_NAME_TOO_LONG);
  // Piece (and its synonyms) is every product's factor-1 level: resolveLadderLevel answers it before
  // any level row, so a unit of that name could never be sold at its own size.
  if (isPieceSynonym(name)) throw new BadRequestException(UNIT_NAME_IS_PIECE);
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
            AND (${sqlKey("baseUnitLabel")} = u."nameKey"
              OR ${sqlKey("packLabel")} = u."nameKey"
              OR ${sqlKey("unit")} = u."nameKey")
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
        await this.audit.log({
          tenantId,
          userId: user.sub,
          action: "tenant_unit.created",
          entityType: "TenantUnit",
          entityId: created.id,
          meta: { name },
        });
        return this.oneRow(tenantId, created.id);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        existing = await db.tenantUnit.findFirst({ where: { tenantId, nameKey } });
        if (!existing) throw e;
      }
    }
    if (existing.archivedAt) {
      // Conditional on still being archived: of two concurrent restores only one matches a row, and
      // only that one audits.
      const { count } = await db.tenantUnit.updateMany({
        where: { id: existing.id, tenantId, archivedAt: { not: null } },
        data: { archivedAt: null },
      });
      const unit = await this.oneRow(tenantId, existing.id);
      if (count === 1) {
        await this.audit.log({
          tenantId,
          userId: user.sub,
          action: "tenant_unit.restored",
          entityType: "TenantUnit",
          entityId: existing.id,
          meta: { name: existing.name, productCount: unit.productCount, via: "add" },
        });
      }
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
    // Already in the asked state: nothing changed, so nothing is written or audited.
    if (archived === (existing.archivedAt != null)) {
      return { unit: await this.oneRow(tenantId, id), productsUpdated: 0 };
    }
    // Conditional on the state still being the one read: of two concurrent requests only one matches a
    // row (count 1) and only that one audits; the other found it already done.
    const { count } = await db.tenantUnit.updateMany({
      where: { id, tenantId, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null },
    });
    const unit = await this.oneRow(tenantId, id); // 404s if the unit vanished meanwhile
    if (count === 0) return { unit, productsUpdated: 0 };
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
      // FIRST statement: nothing below may interleave with a pack edit or a level write.
      await lockTenantUnits(tx, tenantId, "exclusive");
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
      // Text candidates by the SAME key the productCount SQL uses (a Prisma `contains` cannot NFC-fold).
      const textHits: Array<{ id: string }> = await tx.$queryRaw(Prisma.sql`
        SELECT p."id" FROM "Product" p
        WHERE p."tenantId" = ${tenantId}
          AND (${sqlKey("baseUnitLabel")} = ${oldKey}
            OR ${sqlKey("packLabel")} = ${oldKey}
            OR ${sqlKey("unit")} = ${oldKey})`);
      const products: Array<{
        id: string;
        name: string;
        baseUnitLabel: string | null;
        packLabel: string | null;
        unit: string | null;
        unitsPerBox: number | null;
      }> = [];
      for (const part of chunks([...new Set([...levelProductIds, ...textHits.map((h) => h.id)])])) {
        products.push(
          ...(await tx.product.findMany({
            where: { tenantId, id: { in: part } },
            select: {
              id: true,
              name: true,
              baseUnitLabel: true,
              packLabel: true,
              unit: true,
              unitsPerBox: true,
            },
          })),
        );
      }

      const matches = (v: string | null) => v != null && unitNameKey(v) === oldKey;
      const levelRows: Array<{
        productId: string;
        label: string;
        factorToBase: number;
        tenantUnitId: string | null;
      }> = [];
      for (const part of chunks(products.map((p) => p.id))) {
        levelRows.push(
          ...(await tx.productUnit.findMany({
            where: { productId: { in: part } },
            select: { productId: true, label: true, factorToBase: true, tenantUnitId: true },
          })),
        );
      }

      // Refuse the WHOLE rename when, in any product, it would leave two labels equal: the (productId,
      // label) unique, base/pack sharing a label with a level, or a level sharing the PACK word
      // (`Product.unit`, "Box" when blank) which the ladder resolves first and so would make the
      // level unreachable (mirrors unit-pack-rules `assertPackKeepsLevelsValid`).
      const levelsByProduct = new Map<string, typeof levelRows>();
      for (const l of levelRows) {
        const list = levelsByProduct.get(l.productId);
        if (list) list.push(l);
        else levelsByProduct.set(l.productId, [l]);
      }
      // A level's meaning (label -> size) is fixed once order or invoice lines carry the label (the same
      // rule ProductUnitsService enforces for a direct label edit). Relabelling to a name that lines
      // already carry at ANOTHER size would make those lines read as this level. Lines are read through
      // their parent order / invoice (a top-level read would miss a NULL-tenant line).
      const lineSizeClash = new Set<string>();
      if (newKey !== oldKey) {
        const factorOf = new Map<string, number>();
        for (const l of levelRows)
          if (l.tenantUnitId === id) factorOf.set(l.productId, l.factorToBase);
        // A pack word that renames with the unit is a level of the pack's own size (Product.unit).
        for (const p of products) {
          if (matches(p.unit) && !factorOf.has(p.id)) factorOf.set(p.id, packFactorOf(p));
        }
        for (const part of chunks([...factorOf.keys()])) {
          const ids = Prisma.join(part);
          const lines: Array<{ productId: string; unitsPerBox: number | null }> =
            await tx.$queryRaw(
              Prisma.sql`
            SELECT oi."productId" AS "productId", oi."unitsPerBox" AS "unitsPerBox"
            FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId"
            WHERE o."tenantId" = ${tenantId} AND oi."productId" IN (${ids})
              AND ${sqlKeyOf(Prisma.sql`oi."unitLabel"`)} = ${newKey}
            UNION
            SELECT ii."productId", ii."unitsPerBox"
            FROM "InvoiceItem" ii JOIN "Invoice" i ON i."id" = ii."invoiceId"
            WHERE i."tenantId" = ${tenantId} AND ii."productId" IN (${ids})
              AND ${sqlKeyOf(Prisma.sql`ii."unitLabel"`)} = ${newKey}`,
            );
          for (const line of lines) {
            const factor = factorOf.get(line.productId);
            if (factor !== undefined && (line.unitsPerBox == null || line.unitsPerBox !== factor)) {
              lineSizeClash.add(line.productId);
            }
          }
        }
      }
      // Why a product cannot take the new name (null = it can). First cause wins per product.
      const collisionOf = (p: (typeof products)[number]): CollisionReason | null => {
        const mine = levelsByProduct.get(p.id) ?? [];
        const renamed = mine.filter((l) => l.tenantUnitId === id);
        // Several levels of one product linked to this unit ("Case" + "case") would all take the new
        // name and break the (productId,label) unique: refuse, the operator fixes the product.
        if (renamed.length > 1) return "DUPLICATE_LEVELS";
        const others = mine.filter((l) => l.tenantUnitId !== id);
        // A case-only change keeps the key, but the unique index compares the exact label.
        if (newKey === oldKey) return others.some((l) => l.label === newName) ? "NAME" : null;
        const keys: string[] = others.map((l) => unitNameKey(l.label));
        if (p.baseUnitLabel && !matches(p.baseUnitLabel)) keys.push(unitNameKey(p.baseUnitLabel));
        if (p.packLabel && !matches(p.packLabel)) keys.push(unitNameKey(p.packLabel));
        // A pack word that renames with this unit is the renamed one, not a clash. A renamed level OR a
        // renamed base label may not take the pack's word (a base named like the pack reads as the pack).
        if ((renamed.length > 0 || matches(p.baseUnitLabel)) && !matches(p.unit)) {
          keys.push(packWordKey(p.unit));
        }
        if (keys.includes(newKey)) return "NAME";
        return lineSizeClash.has(p.id) ? "LINES_AT_OTHER_SIZE" : null;
      };
      const colliding = products.flatMap((p) => {
        const reason = collisionOf(p);
        return reason ? [{ p, reason }] : [];
      });
      if (colliding.length > 0) throw this.renameCollision(colliding, newName, unit.name as string);

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
      try {
        await tx.productUnit.updateMany({
          where: { tenantId, tenantUnitId: id },
          data: { label: newName },
        });
      } catch (e) {
        // Backstop for a clash the pre-check could not see (a level written in a race): still the
        // collision 409, and the throw rolls the whole rename back.
        if (isUniqueViolation(e)) throw this.renameCollision([], newName, unit.name as string);
        throw e;
      }
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
      // Inside the transaction: a rename that is not on the trail is rolled back with its audit row
      // (AuditService.log swallows its own failures, so it cannot give that guarantee).
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          action: "tenant_unit.renamed",
          entityType: "TenantUnit",
          entityId: id,
          meta: { from: unit.name as string, to: newName, productsUpdated: distinct.size },
        },
      });
      return { updated, productsUpdated: distinct.size };
    }, RENAME_TX_OPTIONS);
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

  private renameCollision(
    colliding: Array<{ p: { id: string; name: string }; reason: CollisionReason }>,
    newName: string,
    oldName: string,
  ): ConflictException {
    const reasons = [...new Set(colliding.map((c) => c.reason))];
    const reason: CollisionReason | "MIXED" =
      reasons.length === 1 ? reasons[0] : reasons.length === 0 ? "NAME" : "MIXED";
    const message: Record<CollisionReason | "MIXED", string> = {
      NAME: `Can't rename to ${newName}: some products already have a ${newName}.`,
      DUPLICATE_LEVELS: `Can't rename to ${newName}: some products have two ${oldName} units that would both become ${newName}.`,
      LINES_AT_OTHER_SIZE: `Can't rename to ${newName}: some products already sold ${newName} at a different size on orders or invoices.`,
      MIXED: `Can't rename to ${newName}: some products can't take that name.`,
    };
    return new ConflictException({
      code: API_ERROR_CODES.UNIT_RENAME_COLLISION,
      reason,
      message: message[reason],
      products: colliding
        .slice(0, MAX_COLLISION_PRODUCTS)
        .map((c) => ({ id: c.p.id, name: c.p.name })),
      total: colliding.length,
    });
  }

  private nameTaken(name: string): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.UNIT_NAME_TAKEN,
      message: `You already have a unit called ${name}.`,
    });
  }
}
