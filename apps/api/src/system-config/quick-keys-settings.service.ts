import { BadRequestException, Injectable } from "@nestjs/common";
import type { QuickKeysSettings } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { validateQuickKeysInput } from "./dto/quick-keys-settings.dto";
import { QuickKeysRankCache } from "./quick-keys-rank.cache";
import {
  QUICK_KEYS_CONFIG_KEY,
  parseQuickKeysSettings,
  type FilledQuickKeysSettings,
} from "./quick-keys-settings";
import { SystemConfigService } from "./system-config.service";

export const QUICK_KEYS_UNKNOWN_PRODUCT_MESSAGE = "quickKeys names a product that does not exist";

/**
 * The tenant's counter QUICK KEYS settings (SA-747): stored as ONE JSON string under SystemConfig
 * `settings.quickKeys`. Reading never throws (a corrupt value is the defaults). Writing is two steps so the
 * caller can validate BEFORE it writes anything else in its request: `prepare` (shape, caps, and that every
 * pinned/hidden id is a product of THIS tenant) then `save` (write, then drop the tenant's ranking cache).
 */
@Injectable()
export class QuickKeysSettingsService {
  constructor(
    private readonly svc: SystemConfigService,
    private readonly prisma: PrismaService,
    private readonly cache: QuickKeysRankCache,
  ) {}

  async read(): Promise<FilledQuickKeysSettings> {
    return parseQuickKeysSettings(await this.svc.get(QUICK_KEYS_CONFIG_KEY));
  }

  /** From the `settings.*` map GET /settings already loaded (no second read). */
  fromAll(all: Record<string, string>): FilledQuickKeysSettings {
    return parseQuickKeysSettings(all[QUICK_KEYS_CONFIG_KEY]);
  }

  async prepare(raw: unknown): Promise<FilledQuickKeysSettings> {
    const value = validateQuickKeysInput(raw);
    const tenantId = this.prisma.getTenantId();
    // forTenant() is UNSCOPED without a tenant, and an undefined `tenantId` key in a where is dropped (L-238).
    if (!tenantId) throw new BadRequestException("quickKeys needs a tenant-scoped session");
    const wanted = new Set<string>();
    for (const reg of [value.counter.default, ...Object.values(value.counter.registers ?? {})]) {
      for (const id of [...reg.pinned, ...reg.hidden]) wanted.add(id);
    }
    if (wanted.size > 0) {
      const found = await this.prisma.forTenant().product.findMany({
        where: { id: { in: [...wanted] }, tenantId },
        select: { id: true },
      });
      if (found.length !== wanted.size) {
        // A product that was pinned or hidden and has since been hard-deleted must not block every later save: ids
        // that are missing AND were already in the stored value are pruned; a NEWLY added unknown id stays a 400.
        const present = new Set(found.map((r) => r.id));
        const stored = await this.read();
        const storedIds = new Set<string>();
        for (const reg of [
          stored.counter.default,
          ...Object.values(stored.counter.registers ?? {}),
        ]) {
          for (const id of [...reg.pinned, ...reg.hidden]) storedIds.add(id);
        }
        const missing = [...wanted].filter((id) => !present.has(id));
        if (missing.some((id) => !storedIds.has(id))) {
          throw new BadRequestException(QUICK_KEYS_UNKNOWN_PRODUCT_MESSAGE);
        }
        const gone = new Set(missing);
        const prune = (reg: { pinned: string[]; hidden: string[] }) => {
          reg.pinned = reg.pinned.filter((id) => !gone.has(id));
          reg.hidden = reg.hidden.filter((id) => !gone.has(id));
        };
        prune(value.counter.default);
        for (const reg of Object.values(value.counter.registers ?? {})) prune(reg);
      }
    }
    return value;
  }

  async save(value: QuickKeysSettings): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("quickKeys needs a tenant-scoped session");
    await this.svc.set(QUICK_KEYS_CONFIG_KEY, JSON.stringify(value));
    this.cache.invalidateTenant(tenantId);
  }
}
