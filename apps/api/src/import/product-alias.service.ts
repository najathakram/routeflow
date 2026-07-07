import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface AliasTarget {
  productId: string | null;
  expenseCategoryId: string | null;
}

/**
 * Learned mapping from a supplier's raw line text → a local product/variant or
 * expense category (spec §5.3), so the next scan/import auto-matches. Tenant-scoped
 * (fixes the cross-tenant collision in the older global ProductMapping). Consumed
 * by the batch line-match chain (Phase 5): SKU → barcode → name → ALIAS.
 */
@Injectable()
export class ProductAliasService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalize raw supplier line text for stable matching. */
  normalize(raw: string): string {
    return (raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  }

  /**
   * Resolve a supplier's raw line text to a learned target. A supplier-specific
   * alias wins over an any-supplier (`""`) alias. Verifies a product target still
   * exists so a deleted product never yields a dangling match.
   */
  async resolve(
    supplierId: string | null | undefined,
    rawText: string,
  ): Promise<AliasTarget | null> {
    this.requireTenant();
    const norm = this.normalize(rawText);
    if (!norm) return null;
    const sid = supplierId ?? "";
    const supplierScopes = sid ? [sid, ""] : [""];
    const rows = await this.prisma.forTenant().productAlias.findMany({
      where: { rawText: norm, supplierId: { in: supplierScopes } },
    });
    if (!rows.length) return null;
    // Supplier-specific alias wins over the any-supplier fallback.
    const chosen = rows.find((r) => r.supplierId === sid) ?? rows[0];
    if (chosen.productId) {
      const exists = await this.prisma.forTenant().product.findUnique({
        where: { id: chosen.productId },
        select: { id: true },
      });
      if (!exists) {
        return { productId: null, expenseCategoryId: chosen.expenseCategoryId };
      }
    }
    return { productId: chosen.productId, expenseCategoryId: chosen.expenseCategoryId };
  }

  /** Learn/overwrite the alias for (supplier, rawText). */
  async learn(
    supplierId: string | null | undefined,
    rawText: string,
    target: { productId?: string | null; expenseCategoryId?: string | null },
  ): Promise<void> {
    const tenantId = this.requireTenant();
    const sid = supplierId ?? "";
    const norm = this.normalize(rawText);
    if (!norm) throw new BadRequestException("Alias text is required.");
    await this.prisma.forTenant().productAlias.upsert({
      where: { tenantId_supplierId_rawText: { tenantId, supplierId: sid, rawText: norm } },
      create: {
        tenantId,
        supplierId: sid,
        rawText: norm,
        productId: target.productId ?? null,
        expenseCategoryId: target.expenseCategoryId ?? null,
      },
      update: {
        productId: target.productId ?? null,
        expenseCategoryId: target.expenseCategoryId ?? null,
      },
    });
  }

  /** List aliases for the tenant (optionally text-filtered). */
  async list(search?: string) {
    const where = search ? { rawText: { contains: this.normalize(search) } } : {};
    return this.prisma.forTenant().productAlias.findMany({
      where,
      orderBy: { rawText: "asc" },
      take: 500,
    });
  }

  /** Delete an alias (tenant-scoped via forTenant()). */
  async remove(id: string): Promise<{ deleted: number }> {
    const res = await this.prisma.forTenant().productAlias.deleteMany({ where: { id } });
    return { deleted: res.count };
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
