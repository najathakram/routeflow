import { ForbiddenException, Injectable } from "@nestjs/common";
import { defaultSellLevel } from "@routeflow/pricing";
import type { QuickKey, QuickKeysResponse } from "@routeflow/types";
import { PrismaService } from "../../prisma/prisma.service";
import { firstSignableImageKey } from "../../products/product-image-keys";
import { scanReadInclude, toScanProductView } from "../../products/scan-product-view";
import { StorageService } from "../../storage/storage.service";
import { QuickKeysRankCache } from "../../system-config/quick-keys-rank.cache";
import { resolveRegister } from "../../system-config/quick-keys-settings";
import { QuickKeysSettingsService } from "../../system-config/quick-keys-settings.service";
import { composeGridIds } from "./quick-keys-grid";
import { rankCounterProducts } from "./quick-keys-rank";

/**
 * GET /orders/counter-sale/quick-keys (SA-747 + SA-747r): the counter screen's grid of one-tap products.
 *
 * Queries per request: 1 settings read, then (on a ranking cache miss only) 1 ranking `$queryRaw`, then ONE
 * tenant-scoped product `findMany` for the whole grid (the pins and the ranked ids together, with the scan
 * lookup's include). The ranking is cached per (tenant, register) for an hour; pins, hides and the cap are read
 * live every time. Each key carries `product`, the SAME shape the scan lookup returns (without `scanMatch`):
 * the grid never decides a price, the screen adds the product through its scan add path.
 */
@Injectable()
export class QuickKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: QuickKeysSettingsService,
    private readonly cache: QuickKeysRankCache,
    private readonly storage: StorageService,
  ) {}

  async get(requestedRegister?: string, now: Date = new Date()): Promise<QuickKeysResponse> {
    const tenantId = this.prisma.getTenantId();
    // forTenant() is UNSCOPED without a tenant, and an undefined tenantId in a where is dropped (L-238): refuse.
    if (!tenantId) throw new ForbiddenException("Quick keys need a tenant-scoped session");

    const reg = resolveRegister(await this.settings.read(), requestedRegister);

    let ranked = this.cache.get(tenantId, reg.register, reg.windowDays);
    if (!ranked) {
      ranked = await rankCounterProducts(this.prisma, tenantId, reg.windowDays, now);
      this.cache.set(tenantId, reg.register, reg.windowDays, ranked);
    }

    // One read for every id the grid could use. Liveness (active, this tenant) is judged by this read, so a
    // pinned product that went inactive, or a ranked one deactivated since the ranking was cached, takes no slot.
    const hidden = new Set(reg.hidden);
    // Every pin is read, not just the first `cap`: a dead pin must not use up a slot a later live pin
    // could fill. composeGridIds applies liveness first and the cap after.
    const wanted = [...new Set([...reg.pinned, ...ranked.filter((id) => !hidden.has(id))])];
    const rows =
      wanted.length === 0
        ? []
        : await this.prisma.forTenant().product.findMany({
            where: { id: { in: wanted }, tenantId, isActive: true },
            include: { ...scanReadInclude(tenantId), barcodes: true },
          });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const slots = composeGridIds({
      pinned: reg.pinned,
      hidden: reg.hidden,
      ranked,
      cap: reg.cap,
      liveIds: new Set(byId.keys()),
    });

    const keys: QuickKey[] = await Promise.all(
      slots.map(async (slot) => {
        const row = byId.get(slot.id)!;
        const imageUrl = await this.imageUrl(row.id, row.imageKeys);
        return {
          productId: row.id,
          name: row.name,
          sellLevel: defaultSellLevel(row),
          ...(imageUrl ? { imageUrl } : {}),
          pinned: slot.pinned,
          product: toScanProductView(row, tenantId) as QuickKey["product"],
        };
      }),
    );
    return { register: reg.register, keys, cap: reg.cap };
  }

  /** The first image the product may have signed (own prefix only, #2533); a signing failure just omits it. */
  private async imageUrl(productId: string, imageKeys: string[]): Promise<string | undefined> {
    const key = firstSignableImageKey(productId, imageKeys);
    if (!key) return undefined;
    try {
      return await this.storage.presignedUrl(key);
    } catch {
      return undefined;
    }
  }
}
