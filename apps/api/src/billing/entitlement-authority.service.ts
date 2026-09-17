import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureResolverService, ResolvedKey } from "./feature-resolver.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { FeatureDiffService } from "./feature-diff.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { addonGateState } from "./addon-gate-registry";
import { isDarkFlag, allowsFlag } from "./plan-flag-policy";
import type { FeatureModeState } from "@routeflow/types";

const FEATURE_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));

/**
 * Design 2026-09-17 §2 "Effective"/"Switch": the ONE evaluation point every consumer calls —
 * both guards, EntitlementsService.hasFlag, SubscriptionService's flags list, and
 * tenants.controller's getMyAddons. `shadow` (default): the OLD path decides (byte-identical to
 * today's AddonGuard/PlanFlagGuard/allowsFlag behavior, dark-flag/dark-addon courtesy allow
 * included) — the resolver runs too and a disagreement upserts FeatureResolverDiff, but never
 * changes what the caller sees. `live`: the resolver decides (old path still diffed for
 * drift-after-flip visibility); a resolver failure falls back to the old path, the same
 * fail-safe direction the existing guards already take on a DB error.
 *
 * The old-path computation here deliberately DOES reproduce the dark-flag/dark-addon courtesy
 * allow (isDarkFlag/allowsFlag/addonGateState) that the resolver deliberately does NOT — that
 * asymmetry is what makes a real diff observable in shadow mode (a courtesy-on key with no
 * actual preset grant), not a bug in either side. Design 09-17 ruling retires that whole
 * mechanism once PR-0c ships; until then this file is the one place both realities coexist.
 */
@Injectable()
export class EntitlementAuthority {
  private readonly logger = new Logger(EntitlementAuthority.name);

  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly resolver: FeatureResolverService,
    private readonly modeService: EntitlementsModeService,
    private readonly diffService: FeatureDiffService,
    // Direct Prisma, not AddonService — see FeatureResolverService's constructor comment
    // for why (BillingModule → EntitlementsModule is a one-way import).
    private readonly prisma: PrismaService,
  ) {}

  async can(tenantId: string, key: string): Promise<boolean> {
    const [mode, oldVerdict] = await Promise.all([
      this.modeService.getMode(),
      this.computeOldPath(tenantId, key),
    ]);

    const resolved = await this.resolver.resolve(tenantId);
    if (resolved === null) {
      // Resolver DB error: shadow → old path decides, unchanged, no diff attempted (oracle 5).
      // Live → fall back to the old path too, same fail-safe direction as today's guards.
      return oldVerdict;
    }

    const newEntry = resolved.byKey.get(key);
    const newVerdict = newEntry?.effective ?? false;
    if (newVerdict !== oldVerdict) {
      await this.diffService.record(
        tenantId,
        key,
        oldVerdict,
        newVerdict,
        newEntry?.source ?? "UNKNOWN",
      );
    }

    return mode === "live" ? newVerdict : oldVerdict;
  }

  /**
   * Brief A ships only the REGISTRY_DEFAULT provider (a config-bearing key's `fallbackMode`,
   * unconditionally) — a tenant-level override provider (`FEATURE_MODE_PROVIDER`) is brief C's
   * `TenantFeatureConfig` work. Never turns a key on/off; a key with no `config` block on its
   * registry row returns a state with an empty `value`/`effective`.
   */
  async config(_tenantId: string, key: string): Promise<FeatureModeState> {
    const feature = FEATURE_BY_KEY.get(key);
    const fallback = feature?.config?.fallbackMode ?? "";
    const modeKeys = feature?.config ? Object.keys(feature.config.modes) : [];
    return {
      value: fallback,
      effective: fallback,
      source: "REGISTRY_DEFAULT",
      allowed: modeKeys,
      blocked: [],
    };
  }

  /** For the explain trace / preview — every key's full resolved detail in one resolver call. */
  async resolveAll(tenantId: string) {
    return this.resolver.resolve(tenantId);
  }

  resolveOneFromBatch(
    byKey: Map<string, ResolvedKey> | undefined,
    key: string,
  ): ResolvedKey | null {
    return byKey?.get(key) ?? null;
  }

  /**
   * Reproduces the exact boolean each guard computes today, override-absolute-priority included
   * (matches AddonGuard's `overrides.get(k)`/PlanFlagGuard's `featureOverrides.get`), so the
   * caller-visible decision in shadow mode is provably unchanged from pre-PR behavior.
   */
  private async computeOldPath(tenantId: string, key: string): Promise<boolean> {
    const override = await this.featureOverrides.get(tenantId, key);
    if (override === "GRANT") return true;
    if (override === "DENY") return false;

    const feature = FEATURE_BY_KEY.get(key);
    const isAddonKeyed = feature?.gate.via === "RequireAddon" || feature?.gate.via === "guard";

    if (isAddonKeyed) {
      const addon = await this.prisma.tenantAddon.findUnique({
        where: { tenantId_addonKey: { tenantId, addonKey: key } },
        select: { active: true },
      });
      if (addon?.active === true) return true;
      if (
        addonGateState(key) === "dark" &&
        !(await this.entitlements.isAlwaysEnforcedTenant(tenantId))
      ) {
        return true;
      }
      return false;
    }

    try {
      const ent = await this.entitlements.resolve(tenantId);
      return allowsFlag(ent, key);
    } catch (err) {
      this.logger.error(
        `Old-path entitlement resolution failed for tenant ${tenantId}`,
        err as Error,
      );
      return isDarkFlag(key);
    }
  }
}
