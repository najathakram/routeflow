import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PIECE_LABEL } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProductUnitDto, UpdateProductUnitDto } from "./dto/product-unit.dto";

interface PackInfo {
  label: string;
  factor: number;
  regulated: boolean;
}

interface LevelKey {
  label: string;
  factorToBase: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * CRUD on a product's `ProductUnit` ladder (units_v1). Every rule here protects a money/stock
 * invariant: a line snapshots its factor, so what must never change under an existing document
 * is the (label → factor) meaning — a level is immutable once any line carries it (mint a new
 * level instead).
 */
@Injectable()
export class ProductUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(productId: string) {
    await this.loadPack(productId);
    return this.prisma.forTenant().productUnit.findMany({
      where: { productId },
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
  }

  async create(productId: string, dto: CreateProductUnitDto) {
    const pack = await this.loadPack(productId);
    const label = this.cleanLabel(dto.label, dto.factorToBase);
    const level = { label, factorToBase: dto.factorToBase };
    this.assertLevelValid(pack, await this.siblings(productId), level);
    await this.assertNoLineDisagrees(productId, label, dto.factorToBase);
    return this.write(productId, dto.isDefaultSelling === true, (tx) =>
      tx.productUnit.create({
        data: {
          productId,
          label,
          factorToBase: dto.factorToBase,
          price: dto.price ?? null,
          priceTier2: dto.priceTier2 ?? null,
          priceTier3: dto.priceTier3 ?? null,
          priceTier4: dto.priceTier4 ?? null,
          priceTier5: dto.priceTier5 ?? null,
          isDefaultSelling: dto.isDefaultSelling === true,
          sortOrder: dto.sortOrder ?? 0,
        },
      }),
    );
  }

  async update(productId: string, unitId: string, dto: UpdateProductUnitDto) {
    const pack = await this.loadPack(productId);
    const row = await this.prisma.forTenant().productUnit.findFirst({
      where: { id: unitId, productId },
    });
    if (!row) throw new NotFoundException("Unit not found");
    const factorToBase = dto.factorToBase ?? row.factorToBase;
    const label = this.cleanLabel(dto.label ?? row.label, factorToBase);
    const siblings = (await this.siblings(productId)).filter((s) => s.id !== unitId);
    this.assertLevelValid(pack, siblings, { label, factorToBase });
    if (factorToBase !== row.factorToBase) {
      await this.assertNoLineDisagrees(productId, row.label, factorToBase);
    }
    if (factorToBase !== row.factorToBase || norm(label) !== norm(row.label)) {
      await this.assertNoLineDisagrees(productId, label, factorToBase);
    }
    const { label: _label, factorToBase: _factor, isDefaultSelling, ...rest } = dto;
    return this.write(
      productId,
      isDefaultSelling === true,
      (tx) =>
        tx.productUnit.update({
          where: { id: unitId },
          data: {
            ...rest,
            label,
            factorToBase,
            ...(isDefaultSelling !== undefined ? { isDefaultSelling } : {}),
          },
        }),
      unitId,
    );
  }

  /** Lines snapshot their own factor + label, so deleting a level cannot alter a document. */
  async remove(productId: string, unitId: string) {
    await this.loadPack(productId);
    const row = await this.prisma.forTenant().productUnit.findFirst({
      where: { id: unitId, productId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("Unit not found");
    await this.prisma.forTenant().productUnit.delete({ where: { id: unitId } });
    return { deleted: true };
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private async loadPack(productId: string): Promise<PackInfo> {
    const p = await this.prisma.forTenant().product.findUnique({
      where: { id: productId },
      select: { unit: true, unitsPerBox: true, trackedCategoryId: true },
    });
    if (!p) throw new NotFoundException("Product not found");
    const upb = Math.trunc(Number(p.unitsPerBox ?? 0));
    return {
      label: (p.unit ?? "").trim() || "Box",
      factor: upb > 1 ? upb : 1,
      regulated: p.trackedCategoryId != null,
    };
  }

  private siblings(productId: string): Promise<Array<LevelKey & { id: string }>> {
    return this.prisma.forTenant().productUnit.findMany({
      where: { productId },
      select: { id: true, label: true, factorToBase: true },
    });
  }

  /** The Piece level is always factor 1, and factor 1 is always named "Piece". */
  private cleanLabel(raw: string, factorToBase: number): string {
    const label = (raw ?? "").trim();
    if (!label) throw new BadRequestException("A unit needs a name");
    if (factorToBase === 1) return PIECE_LABEL;
    if (norm(label) === norm(PIECE_LABEL)) {
      throw new BadRequestException(`"${PIECE_LABEL}" is always exactly 1 piece`);
    }
    return label;
  }

  private assertLevelValid(pack: PackInfo, siblings: LevelKey[], level: LevelKey): void {
    if (level.factorToBase === pack.factor) {
      throw new BadRequestException(
        pack.factor === 1
          ? "This product has no pack size — a piece is the product itself; set its price on the product."
          : `${level.factorToBase} pieces is the pack size — set the pack's own price on the product.`,
      );
    }
    if (norm(level.label) === norm(pack.label)) {
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

  /**
   * Factors are immutable once used: refuse when any order/invoice line for this product carries
   * `label` with a DIFFERENT factor than the one being written. Catches a factor edit, a rename
   * onto a used label, and delete-then-recreate with a new factor.
   */
  private async assertNoLineDisagrees(
    productId: string,
    label: string,
    factorToBase: number,
  ): Promise<void> {
    const where = {
      productId,
      unitLabel: { equals: label, mode: "insensitive" as const },
      // Explicit OR: SQL `NOT (col = n)` drops NULL rows, and a line with no snapshot factor is
      // exactly the one we must not let slip past.
      OR: [{ unitsPerBox: null }, { unitsPerBox: { not: factorToBase } }],
    };
    const db = this.prisma.forTenant();
    const [order, invoice] = await Promise.all([
      db.orderItem.findFirst({ where, select: { id: true } }),
      db.invoiceItem.findFirst({ where, select: { id: true } }),
    ]);
    if (order || invoice) {
      throw new ConflictException(
        `"${label}" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.`,
      );
    }
  }

  /** At most one default selling unit per product; setting one clears the others atomically. */
  private write<T>(
    productId: string,
    makeDefault: boolean,
    fn: (tx: any) => Promise<T>,
    keepUnitId?: string,
  ): Promise<T> {
    return this.prisma.tenantTransaction(async (tx) => {
      if (makeDefault) {
        await tx.productUnit.updateMany({
          where: {
            productId,
            isDefaultSelling: true,
            ...(keepUnitId ? { NOT: { id: keepUnitId } } : {}),
          },
          data: { isDefaultSelling: false },
        });
      }
      return fn(tx);
    });
  }
}
