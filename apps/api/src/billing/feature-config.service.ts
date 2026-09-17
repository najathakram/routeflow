import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FEATURE_REGISTRY, gateVia } from "./feature-registry";
import { FeatureConfigStore } from "./feature-config.store";

export const FEATURE_CONFIG_SET_ACTION = "FEATURE_CONFIG_SET";
export const FEATURE_CONFIG_CLEARED_ACTION = "FEATURE_CONFIG_CLEARED";

export interface FeatureConfigModeState {
  value: string;
  effective: string;
  source: "TENANT" | "REGISTRY_DEFAULT";
  allowed: string[];
  blocked: string[];
}

/**
 * Feature grants v2 brief C (PR-4). Validates and writes a tenant's per-feature config-mode
 * override — separate class from `FeatureConfigStore` on purpose: this one injects "the
 * authority" (AddonService/EntitlementsService, to check `requires.allOf`), and only
 * `FeatureConfigStore` (Prisma-only) is bound to the optional `FEATURE_MODE_PROVIDER` token A's
 * future authority injects, so there is no constructor cycle between the two.
 */
@Injectable()
export class FeatureConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: FeatureConfigStore,
    private readonly audit: AuditService,
    private readonly addons: AddonService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * True when `tenantId` currently holds `key` — dispatches on the key's OWN gate kind
   * (`gateVia`), not on `routes_dispatch`'s. `recurring_routes`/`order_delivery` (the only
   * `requires.allOf` targets today) are RequireAddon keys, so this resolves via AddonService;
   * a future config mode naming a RequirePlanFlag key resolves via EntitlementsService.hasFlag.
   * A key with no separate grant surface (`gate.via` "none"/"guard"/"service", or unregistered)
   * has nothing to check here — treated as held, matching how those keys behave everywhere else
   * (no gate to deny at).
   */
  private async can(tenantId: string, key: string): Promise<boolean> {
    const via = gateVia(key);
    if (via === "RequireAddon") return this.addons.hasAddon(tenantId, key);
    if (via === "RequirePlanFlag") return this.entitlements.hasFlag(tenantId, key);
    return true;
  }

  private registryRow(key: string) {
    return FEATURE_REGISTRY.find((f) => f.key === key);
  }

  /** Read-only projection used by the controller's GET and by consumers that want the full
   * allowed/blocked breakdown, not just the raw stored value. */
  async getState(tenantId: string, key: string): Promise<FeatureConfigModeState> {
    const row = this.registryRow(key);
    if (!row?.config) {
      throw new BadRequestException(`"${key}" has no config modes`);
    }
    const { value, source } = await this.store.getMode(tenantId, key);
    const allowed: string[] = [];
    const blocked: string[] = [];
    for (const [modeName, mode] of Object.entries(row.config.modes)) {
      const requiredKeys = mode.requires?.allOf ?? [];
      let holdsAll = true;
      for (const req of requiredKeys) {
        if (!(await this.can(tenantId, req))) {
          holdsAll = false;
          break;
        }
      }
      (holdsAll ? allowed : blocked).push(modeName);
    }
    return { value, effective: value, source, allowed, blocked };
  }

  /**
   * Sets `tenantId`'s mode for `key`. Unknown key/mode -> 400. A mode whose `requires.allOf`
   * names an entitlement the tenant does NOT hold -> 409 naming the first missing key. Never
   * touches another tenant's row: `where: { tenantId, featureKey }` is always scoped together
   * (the compound unique index), never `featureKey` alone.
   */
  async set(
    tenantId: string,
    key: string,
    mode: string,
    reason: string,
    byUserId: string | null,
  ): Promise<void> {
    const row = this.registryRow(key);
    if (!row?.config) {
      throw new BadRequestException(`"${key}" has no config modes`);
    }
    const modeDef = row.config.modes[mode];
    if (!modeDef) {
      throw new BadRequestException(
        `"${mode}" is not a valid mode for "${key}" (valid: ${Object.keys(row.config.modes).join(", ")})`,
      );
    }

    for (const required of modeDef.requires?.allOf ?? []) {
      if (!(await this.can(tenantId, required))) {
        throw new ConflictException({
          code: "FEATURE_MODE_REQUIRES",
          key,
          mode,
          missing: required,
          message: `"${mode}" requires "${required}", which this tenant does not hold`,
        });
      }
    }

    await this.prisma.tenantFeatureConfig.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey: key } },
      create: { tenantId, featureKey: key, mode, reason, updatedById: byUserId },
      update: { mode, reason, updatedById: byUserId },
    });
    this.store.invalidate(tenantId, key);

    await this.audit.log({
      tenantId,
      userId: byUserId,
      action: FEATURE_CONFIG_SET_ACTION,
      entityType: "TenantFeatureConfig",
      entityId: key,
      meta: { key, mode, reason },
    });
  }

  /** Clears `tenantId`'s override for `key`, reverting it to the registry `fallbackMode`. A
   * clear on a key with no existing row is a no-op (still audited, still `where:{tenantId,
   * featureKey}` scoped) — deleteMany rather than delete so it never throws P2025. */
  async clear(
    tenantId: string,
    key: string,
    reason: string,
    byUserId: string | null,
  ): Promise<void> {
    const row = this.registryRow(key);
    if (!row?.config) {
      throw new BadRequestException(`"${key}" has no config modes`);
    }

    await this.prisma.tenantFeatureConfig.deleteMany({
      where: { tenantId, featureKey: key },
    });
    this.store.invalidate(tenantId, key);

    await this.audit.log({
      tenantId,
      userId: byUserId,
      action: FEATURE_CONFIG_CLEARED_ACTION,
      entityType: "TenantFeatureConfig",
      entityId: key,
      meta: { key, reason },
    });
  }
}
