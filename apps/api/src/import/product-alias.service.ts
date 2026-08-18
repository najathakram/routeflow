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

  /**
   * Batched `resolve()` for a whole scan's worth of lines — one round trip
   * instead of N. Same supplier-then-any-supplier precedence and dangling
   * product cleanup as `resolve()`, keyed by the ORIGINAL raw text passed in
   * (not the normalized form) so callers can look a line up directly. No
   * tenant context returns an empty map rather than throwing — matching runs
   * opportunistically inside a scan and must never abort it.
   */
  async resolveMany(
    supplierId: string | null | undefined,
    rawTexts: string[],
  ): Promise<Map<string, AliasTarget>> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return new Map();

    const sid = supplierId ?? "";
    const supplierScopes = sid ? [sid, ""] : [""];

    // Group the original raw strings by their normalized form so duplicate/
    // near-duplicate lines share one lookup and one result.
    const rawByNorm = new Map<string, string[]>();
    for (const raw of rawTexts) {
      const norm = this.normalize(raw);
      if (!norm) continue;
      const group = rawByNorm.get(norm);
      if (group) group.push(raw);
      else rawByNorm.set(norm, [raw]);
    }
    if (rawByNorm.size === 0) return new Map();

    const rows = await this.prisma.forTenant().productAlias.findMany({
      where: { rawText: { in: [...rawByNorm.keys()] }, supplierId: { in: supplierScopes } },
    });
    if (!rows.length) return new Map();

    // Supplier-specific alias wins over the any-supplier fallback, per
    // normalized text — same precedence as resolve().
    const chosenByNorm = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = chosenByNorm.get(row.rawText);
      if (!existing || (existing.supplierId !== sid && row.supplierId === sid)) {
        chosenByNorm.set(row.rawText, row);
      }
    }

    // One batched existence check for every aliased product instead of one
    // query per line, so a deleted product never yields a dangling match.
    const productIds = [
      ...new Set(
        [...chosenByNorm.values()].map((r) => r.productId).filter((id): id is string => !!id),
      ),
    ];
    const existingProductIds = productIds.length
      ? new Set(
          (
            await this.prisma
              .forTenant()
              .product.findMany({ where: { id: { in: productIds } }, select: { id: true } })
          ).map((p) => p.id),
        )
      : new Set<string>();

    const result = new Map<string, AliasTarget>();
    for (const [norm, rawGroup] of rawByNorm) {
      const row = chosenByNorm.get(norm);
      if (!row) continue;
      const productId =
        row.productId && existingProductIds.has(row.productId) ? row.productId : null;
      const target: AliasTarget = { productId, expenseCategoryId: row.expenseCategoryId };
      for (const raw of rawGroup) result.set(raw, target);
    }
    return result;
  }

  /**
   * Forget a learned correction at BOTH scopes — the supplier-specific one
   * AND the "" any-supplier fallback. The operator's intent when clearing a
   * remembered match is "stop suggesting this", and the suggestion may have
   * come from the "" fallback, which a supplier-scoped-only delete would miss.
   */
  async unlearn(
    supplierId: string | null | undefined,
    rawText: string,
  ): Promise<{ deleted: number }> {
    const tenantId = this.requireTenant();
    const norm = this.normalize(rawText);
    if (!norm) return { deleted: 0 };
    const sid = supplierId ?? "";
    const res = await this.prisma.forTenant().productAlias.deleteMany({
      where: { tenantId, rawText: norm, supplierId: { in: [sid, ""] } },
    });
    return { deleted: res.count };
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
