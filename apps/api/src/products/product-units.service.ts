import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PIECE_LABEL,
  baseLabelOf,
  deriveChainFactors,
  packLabelOf,
  validateUnitChain,
  type ChainLevel,
  type ChainViolation,
} from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProductUnitDto, UpdateProductUnitDto } from "./dto/product-unit.dto";

interface PackInfo {
  label: string;
  /** The pack's legacy unit text (Product.unit) — also names the pack. */
  legacyLabel: string;
  /** Units rebuild P0b: the base unit's name (baseLabelOf — "Piece" when unset). */
  baseLabel: string;
  factor: number;
  regulated: boolean;
}

interface LevelKey {
  label: string;
  factorToBase: number;
}

type Sibling = LevelKey & {
  id: string;
  parentUnitId?: string | null;
  perParent?: number | null;
};

const norm = (s: string) => s.trim().toLowerCase();

/** What the API returns for a level — never `tenantId` or audit columns. */
const UNIT_SELECT = {
  id: true,
  label: true,
  factorToBase: true,
  price: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  isDefaultSelling: true,
  sortOrder: true,
  parentUnitId: true,
  perParent: true,
} as const;

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * CRUD on a product's `ProductUnit` ladder (units_v1). Every rule here protects a money/stock
 * invariant: a line snapshots its factor, so what must never change under an existing document
 * is the (label → factor) meaning — a level is immutable once any line carries it (mint a new
 * level instead).
 *
 * Every mutation runs as ONE transaction holding a per-product advisory lock, with all reads
 * (pack, siblings, line check) inside it: the label/factor uniqueness, the single default unit
 * and the immutability check all see the committed truth and cannot race a concurrent editor.
 */
@Injectable()
export class ProductUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(productId: string) {
    await this.loadPack(this.prisma.forTenant(), productId);
    return this.prisma.forTenant().productUnit.findMany({
      where: { productId },
      select: UNIT_SELECT,
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
  }

  create(productId: string, dto: CreateProductUnitDto) {
    return this.locked(productId, async (tx) => {
      const pack = await this.loadPack(tx, productId);
      const label = this.cleanLabel(dto.label, dto.factorToBase, pack);
      const siblings = await this.siblings(tx, productId);
      this.assertLevelValid(pack, siblings, { label, factorToBase: dto.factorToBase });
      this.assertChain(siblings, {
        id: "__new__",
        label,
        factorToBase: dto.factorToBase,
        parentUnitId: dto.parentUnitId ?? null,
        perParent: dto.perParent ?? null,
      });
      await this.assertNoLineDisagrees(tx, productId, label, dto.factorToBase);
      const makeDefault = dto.isDefaultSelling === true;
      if (makeDefault) await this.clearDefaults(tx, productId);
      return tx.productUnit.create({
        data: {
          productId,
          label,
          factorToBase: dto.factorToBase,
          parentUnitId: dto.parentUnitId ?? null,
          perParent: dto.perParent ?? null,
          price: dto.price ?? null,
          priceTier2: dto.priceTier2 ?? null,
          priceTier3: dto.priceTier3 ?? null,
          priceTier4: dto.priceTier4 ?? null,
          priceTier5: dto.priceTier5 ?? null,
          isDefaultSelling: makeDefault,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: UNIT_SELECT,
      });
    });
  }

  update(productId: string, unitId: string, dto: UpdateProductUnitDto) {
    return this.locked(productId, async (tx) => {
      const pack = await this.loadPack(tx, productId);
      const row = await tx.productUnit.findFirst({ where: { id: unitId, productId } });
      if (!row) throw new NotFoundException("Unit not found");
      const factorToBase = dto.factorToBase ?? row.factorToBase;
      const label = this.cleanLabel(dto.label ?? row.label, factorToBase, pack);
      const all = await this.siblings(tx, productId);
      const siblings = all.filter((s) => s.id !== unitId);
      this.assertLevelValid(pack, siblings, { label, factorToBase });
      await this.assertImmutableIfUsed(tx, productId, row, { label, factorToBase });
      // P0b: validate the whole tree with this edit applied; a parent edit recomputes descendants
      // (factorToBase = perParent x parent) and each changed descendant is checked + written below.
      const descendants = this.assertChain(
        siblings,
        {
          id: unitId,
          label,
          factorToBase,
          parentUnitId:
            dto.parentUnitId !== undefined ? dto.parentUnitId : (row.parentUnitId ?? null),
          perParent: dto.perParent !== undefined ? dto.perParent : (row.perParent ?? null),
        },
        true,
      );
      for (const d of descendants) {
        await this.assertNoLineDisagrees(tx, productId, d.label, d.factorToBase);
      }
      const { label: _l, factorToBase: _f, isDefaultSelling, ...rest } = dto;
      if (isDefaultSelling === true) await this.clearDefaults(tx, productId, unitId);
      for (const d of descendants) {
        await tx.productUnit.update({
          where: { id: d.id },
          data: { factorToBase: d.factorToBase },
        });
      }
      return tx.productUnit.update({
        where: { id: unitId },
        data: {
          ...rest,
          label,
          factorToBase,
          ...(isDefaultSelling !== undefined ? { isDefaultSelling } : {}),
        },
        select: UNIT_SELECT,
      });
    });
  }

  /**
   * Lines snapshot their own factor + price, so deleting a level cannot change what a document
   * charged. (Their `unitLabel` then names a level that no longer exists — a later re-resolution
   * of that label must fall back to the line's own snapshot, never throw.)
   */
  remove(productId: string, unitId: string) {
    return this.locked(productId, async (tx) => {
      await this.loadPack(tx, productId);
      const row = await tx.productUnit.findFirst({
        where: { id: unitId, productId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException("Unit not found");
      const child = (await this.siblings(tx, productId)).find((s) => s.parentUnitId === unitId);
      if (child) {
        throw new ConflictException(
          `"${child.label}" is counted in this unit — remove or re-parent it first.`,
        );
      }
      await tx.productUnit.delete({ where: { id: unitId } });
      return { deleted: true };
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** One transaction + a per-product advisory xact lock; unique-index races become a 409. */
  private async locked<T>(productId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    // A write needs a tenant: without one `tenantTransaction` hands back the raw client and the
    // insert would carry no tenantId (a 500 on the NOT NULL column). SUPER_ADMIN must act inside a tenant.
    if (!this.prisma.getTenantId()) {
      throw new BadRequestException("Select a tenant before editing a product's units.");
    }
    try {
      return await this.prisma.tenantTransaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${productId}))`;
        return fn(tx);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException("This product already has a unit with that name or size.");
      }
      throw e;
    }
  }

  /** `findFirst` (not `findUnique`) so the tenant filter is ANDed into the WHERE — a foreign
   *  product 404s instead of leaking its pack shape. */
  private async loadPack(db: any, productId: string): Promise<PackInfo> {
    const p = await db.product.findFirst({
      where: { id: productId },
      select: {
        unit: true,
        baseUnitLabel: true,
        packLabel: true,
        unitsPerBox: true,
        trackedCategoryId: true,
      },
    });
    if (!p) throw new NotFoundException("Product not found");
    const upb = Math.trunc(Number(p.unitsPerBox ?? 0));
    return {
      label: packLabelOf(p),
      legacyLabel: (p.unit ?? "").trim(),
      baseLabel: baseLabelOf(p),
      factor: upb > 1 ? upb : 1,
      regulated: p.trackedCategoryId != null,
    };
  }

  private siblings(db: any, productId: string): Promise<Sibling[]> {
    return db.productUnit.findMany({
      where: { productId },
      select: { id: true, label: true, factorToBase: true, parentUnitId: true, perParent: true },
    });
  }

  /**
   * P0b: the ladder is a tree rooted at the base. Validates `others + level` with the pure
   * @routeflow/pricing validator (structure → 400; a collision or over-cap → 409) and returns the
   * descendants of `level` whose factor a recompute changed (only when `recompute`).
   */
  private assertChain(
    others: Sibling[],
    level: Sibling,
    recompute = false,
  ): Array<{ id: string; label: string; factorToBase: number }> {
    const toChain = (s: Sibling): ChainLevel => ({
      key: s.id,
      factorToBase: s.factorToBase,
      parentKey: s.parentUnitId ?? null,
      perParent: s.perParent ?? null,
    });
    const before = [...others, level].map(toChain);
    const derived = recompute ? deriveChainFactors(before) : before;
    const result = validateUnitChain(derived);
    if (!result.ok) {
      const worst: ChainViolation =
        result.violations.find((v) => v.code === "OVER_CAP" || v.code === "DUPLICATE_FACTOR") ??
        result.violations[0];
      if (worst.code === "OVER_CAP" || worst.code === "DUPLICATE_FACTOR") {
        throw new ConflictException(worst.message);
      }
      throw new BadRequestException(worst.message);
    }
    const labelOf = new Map(others.map((o) => [o.id, o.label]));
    return derived
      .filter((d, i) => d.key !== level.id && d.factorToBase !== before[i].factorToBase)
      .map((d) => ({ id: d.key, label: labelOf.get(d.key) ?? "", factorToBase: d.factorToBase }));
  }

  private clearDefaults(db: any, productId: string, exceptUnitId?: string) {
    return db.productUnit.updateMany({
      where: {
        productId,
        isDefaultSelling: true,
        ...(exceptUnitId ? { NOT: { id: exceptUnitId } } : {}),
      },
      data: { isDefaultSelling: false },
    });
  }

  /** The base level is always factor 1 and factor 1 is always exactly the base label (P0b: the tenant's
   *  name, "Piece" when unset; the legacy "Piece" spelling is still accepted and canonicalised). */
  private cleanLabel(raw: string, factorToBase: number, pack: PackInfo): string {
    const label = (raw ?? "").trim();
    if (!label) throw new BadRequestException("A unit needs a name");
    const isBase = norm(label) === norm(pack.baseLabel) || norm(label) === norm(PIECE_LABEL);
    if (factorToBase === 1 && !isBase) {
      throw new BadRequestException(`A 1-piece unit is always named "${pack.baseLabel}".`);
    }
    if (factorToBase !== 1 && isBase) {
      throw new BadRequestException(`"${pack.baseLabel}" is always exactly 1 piece.`);
    }
    return factorToBase === 1 ? pack.baseLabel : label;
  }

  private assertLevelValid(pack: PackInfo, siblings: LevelKey[], level: LevelKey): void {
    if (level.factorToBase === pack.factor) {
      throw new BadRequestException(
        pack.factor === 1
          ? "This product has no pack size — a piece is the product itself; set its price on the product."
          : `${level.factorToBase} pieces is the pack size — set the pack's own price on the product.`,
      );
    }
    if (
      norm(level.label) === norm(pack.label) ||
      (pack.legacyLabel !== "" && norm(level.label) === norm(pack.legacyLabel))
    ) {
      throw new BadRequestException(`"${level.label}" is already the name of the pack.`);
    }
    if (pack.regulated && level.factorToBase > pack.factor) {
      throw new BadRequestException(
        "A regulated product cannot be sold above its pack size (a filing could not count it).",
      );
    }
    if (siblings.some((s) => norm(s.label) === norm(level.label))) {
      throw new ConflictException(`This product already has a unit named "${level.label}".`);
    }
    if (siblings.some((s) => s.factorToBase === level.factorToBase)) {
      throw new ConflictException(
        `This product already has a unit of ${level.factorToBase} pieces.`,
      );
    }
  }

  /** A factor change checks the OLD label (its lines keep the old factor); any factor or label
   *  change checks the NEW pair. A price/default/order-only edit never queries the lines. */
  private async assertImmutableIfUsed(
    tx: any,
    productId: string,
    row: LevelKey,
    next: LevelKey,
  ): Promise<void> {
    const factorChanged = next.factorToBase !== row.factorToBase;
    const labelChanged = norm(next.label) !== norm(row.label);
    // Factor AND label both change: the OLD label's lines would no longer match this row.
    if (factorChanged && labelChanged) {
      await this.assertNoLineDisagrees(tx, productId, row.label, next.factorToBase);
    }
    if (factorChanged || labelChanged) {
      await this.assertNoLineDisagrees(tx, productId, next.label, next.factorToBase);
    }
  }

  /**
   * Factors are immutable once used: refuse when any order/invoice line for this product carries
   * `label` with a DIFFERENT factor than the one being written. Catches a factor edit, a rename
   * onto a used label, and delete-then-recreate with a new factor.
   */
  private async assertNoLineDisagrees(
    db: any,
    productId: string,
    label: string,
    factorToBase: number,
  ): Promise<void> {
    // Through the PARENT (order/invoice) relation, never `orderItem`/`invoiceItem` top-level: a
    // top-level read is scoped by the ITEM's nullable tenantId and would miss a NULL-tenant line.
    const lineWhere = {
      productId,
      unitLabel: { equals: label, mode: "insensitive" as const },
      // Explicit OR: SQL `NOT (col = n)` drops NULL rows, and a line with no snapshot factor is
      // exactly the one we must not let slip past.
      OR: [{ unitsPerBox: null }, { unitsPerBox: { not: factorToBase } }],
    };
    const [order, invoice] = await Promise.all([
      db.order.findFirst({ where: { lineItems: { some: lineWhere } }, select: { id: true } }),
      db.invoice.findFirst({ where: { items: { some: lineWhere } }, select: { id: true } }),
    ]);
    if (order || invoice) {
      throw new ConflictException(
        `"${label}" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.`,
      );
    }
  }
}
