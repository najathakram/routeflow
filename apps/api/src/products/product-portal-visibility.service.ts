import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

/**
 * Staff writer for Product.portalVisible (buyer-portal visibility). Sets ONLY the named rows' flag:
 * a family/parent toggle never cascades to its variants (the buyer read rule hides them).
 * Kept out of ProductsService (size ratchet).
 */
@Injectable()
export class ProductPortalVisibilityService {
  private readonly logger = new Logger(ProductPortalVisibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  async setOne(id: string, portalVisible: boolean, userId: string | null) {
    await this.apply([id], portalVisible, userId);
    return { id, portalVisible };
  }

  async setBulk(ids: string[], portalVisible: boolean, userId: string | null) {
    const changed = await this.apply(ids, portalVisible, userId);
    return { portalVisible, updated: changed.length, unchanged: ids.length - changed.length };
  }

  /** Returns the ids whose value actually changed. All-or-nothing: one tx, ids asserted first. */
  private async apply(
    ids: string[],
    portalVisible: boolean,
    userId: string | null,
  ): Promise<string[]> {
    const changed = await this.prisma.tenantTransaction(async (tx: any) => {
      const rows: { id: string; portalVisible: boolean }[] = await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, portalVisible: true },
      });
      // Prisma drops undefined where keys and widens a many-write: prove the resolved set equals
      // the requested set BEFORE any write.
      const found = new Set(rows.map((r) => r.id));
      if (found.size !== new Set(ids).size || ids.some((i) => !found.has(i))) {
        throw new NotFoundException("Product not found");
      }
      const toChange = rows.filter((r) => r.portalVisible !== portalVisible).map((r) => r.id);
      if (toChange.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: toChange } },
          data: { portalVisible },
        });
      }
      return toChange;
    });
    if (changed.length === 0) return changed;

    const tenantId = this.prisma.getTenantId();
    for (const entityId of changed) {
      await this.audit.log({
        tenantId,
        userId,
        action: "product.portal_visibility_changed",
        entityType: "Product",
        entityId,
        meta: { from: !portalVisible, to: portalVisible },
      });
    }
    try {
      this.gateway.emitProductUpdated(
        tenantId,
        ids.length === 1
          ? { productId: changed[0], action: "updated" }
          : { productId: null, action: "bulk" },
      );
    } catch (err) {
      this.logger.warn(
        `product.updated emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return changed;
  }
}
