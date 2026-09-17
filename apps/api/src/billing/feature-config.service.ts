import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  Injectable,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
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
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  /**
   * True when `tenantId` currently holds `key`. Fix round 1 (Opus review, item 2): an active
   * #795 override on `key` is checked FIRST and is absolute — GRANT/DENY decide outright,
   * exactly like `AddonGuard`/`EntitlementsService.hasFlag` already do — only its absence falls
   * through to the key's own gate kind (`gateVia`, not `routes_dispatch`'s):
   * `recurring_routes`/`order_delivery` (the only `requires.allOf` targets today) are
   * RequireAddon keys, so that resolves via AddonService; a future config mode naming a
   * RequirePlanFlag key resolves via EntitlementsService.hasFlag. This is a stand-in for brief
   * A's real authority `can()` (not on this base yet) — remove once that lands. A key with no
   * separate grant surface (`gate.via` "none"/"guard"/"service", or unregistered) has nothing
   * left to check — treated as held, matching how those keys behave everywhere else.
   */
  private async can(tenantId: string, key: string): Promise<boolean> {
    const override = await this.featureOverrides.get(tenantId, key);
    if (override === "GRANT") return true;
    if (override === "DENY") return false;

    const via = gateVia(key);
    if (via === "RequireAddon") return this.addons.hasAddon(tenantId, key);
    if (via === "RequirePlanFlag") return this.entitlements.hasFlag(tenantId, key);
    return true;
  }

  private registryRow(key: string) {
    return FEATURE_REGISTRY.find((f) => f.key === key);
  }

  /**
   * Fix round 1 (Opus review, item 1): the STORED value is not necessarily the EFFECTIVE one —
   * a tenant set to "scheduled" who later lost `recurring_routes` (addon revoked, override
   * flipped to DENY, …) must fall back to the registry `fallbackMode` ("unset", which allows
   * every kind) rather than stay stuck enforcing a mode it no longer qualifies for. A stored
   * value naming a mode that no longer exists in the registry (a removed mode) falls back the
   * same way.
   */
  private async resolveEffective(
    tenantId: string,
    config: {
      fallbackMode: string;
      modes: Record<string, { requires?: { allOf?: readonly string[] } }>;
    },
    value: string,
  ): Promise<string> {
    const modeDef = config.modes[value];
    if (!modeDef) return config.fallbackMode;
    for (const required of modeDef.requires?.allOf ?? []) {
      if (!(await this.can(tenantId, required))) return config.fallbackMode;
    }
    return value;
  }

  /** The tenant's effective `key` mode — what a consumer (RoutesService.createRun) should
   * actually gate on, never the raw stored value. Returns the registry fallback for a key with
   * no config block, so a defensive caller never has to special-case "not configurable". */
  async getEffectiveMode(tenantId: string, key: string): Promise<string> {
    const row = this.registryRow(key);
    if (!row?.config) return "unset";
    const { value } = await this.store.getMode(tenantId, key);
    return this.resolveEffective(tenantId, row.config, value);
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
    const effective = await this.resolveEffective(tenantId, row.config, value);
    return { value, effective, source, allowed, blocked };
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
    // Fix round 1 (Opus review, item 4): a mode can exist in the registry but be marked
    // unavailable for selection (e.g. catalog_varieties' "single_sku") — refuse it the same way
    // as an unknown mode name, not just an unknown key.
    if (!modeDef.available) {
      throw new BadRequestException(`"${mode}" is not available for "${key}"`);
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

    // Fix round 1 (Opus review, item 4): an unknown tenant id would otherwise hit the
    // TenantFeatureConfig.tenant FK constraint on create() and surface as an unhandled 500 —
    // a clean 404 names the actual problem.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${tenantId}" not found`);
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
