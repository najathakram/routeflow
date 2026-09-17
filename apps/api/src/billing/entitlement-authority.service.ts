import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureResolverService, ResolvedKey } from "./feature-resolver.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { FeatureDiffService } from "./feature-diff.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { addonGateState } from "./addon-gate-registry";
import { isDarkFlag, allowsFlag, computeServedFlags } from "./plan-flag-policy";
import type { FeatureModeState, FeatureSource } from "@routeflow/types";

/** Fire-and-forget diff writes (item 3): suppress a re-write of the SAME disagreement from
 *  the SAME tenant within this window — a hot key flips the guard on every request, and
 *  without this a busy tenant would hammer the DB with redundant upserts of a row whose
 *  count/lastSeenAt churn nobody reads at that frequency. */
const DIFF_MEMO_TTL_MS = 10 * 60_000;

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
  /** memo key `tenantId:featureKey:before:after` → expiresAt (ms) — see DIFF_MEMO_TTL_MS. */
  private readonly diffMemo = new Map<string, number>();

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
      // Item 3 (Opus review of 9923b87c): fire-and-forget — a diff-log write is an audit
      // trail, never a reason to add latency or a failure mode to the guard decision that
      // triggered it. Not `await`ed; errors are caught and logged, never thrown.
      this.recordDiffMemoized(tenantId, key, oldVerdict, newVerdict, newEntry?.source ?? "UNKNOWN");
    }

    return mode === "live" ? newVerdict : oldVerdict;
  }

  /** Suppresses a redundant fire-and-forget write of the identical disagreement within
   *  DIFF_MEMO_TTL_MS (see the constant's own comment), else delegates to
   *  FeatureDiffService.record() without awaiting it. */
  private recordDiffMemoized(
    tenantId: string,
    key: string,
    before: boolean,
    after: boolean,
    source: FeatureSource,
  ): void {
    const memoKey = `${tenantId}:${key}:${before}:${after}`;
    const now = Date.now();
    const expiresAt = this.diffMemo.get(memoKey);
    if (expiresAt !== undefined && expiresAt > now) return;
    this.diffMemo.set(memoKey, now + DIFF_MEMO_TTL_MS);
    if (this.diffMemo.size > 5000) this.pruneDiffMemo(now);

    void this.diffService.record(tenantId, key, before, after, source).catch((err) => {
      this.logger.error(
        `Fire-and-forget diff record failed for tenant ${tenantId} key ${key}`,
        err as Error,
      );
    });
  }

  private pruneDiffMemo(now: number): void {
    for (const [k, expiresAt] of this.diffMemo) {
      if (expiresAt <= now) this.diffMemo.delete(k);
    }
  }

  /**
   * `served` for `/tenants/me/features` (item 2): the SAME array `getSubscription().flags`
   * returns, via the SAME shared function — see plan-flag-policy.ts's computeServedFlags
   * doc comment for why this is provably identical rather than a re-derivation.
   */
  async servedFlags(tenantId: string): Promise<string[]> {
    const [ent, overrides] = await Promise.all([
      this.entitlements.resolve(tenantId),
      this.featureOverrides.allActive(tenantId),
    ]);
    return computeServedFlags(ent.planKey, ent.flags, overrides);
  }

  /**
   * Old-path verdict for EVERY registry key (item 5's `serving`) — fetches each collaborator
   * ONCE (mirrors FeatureResolverService.compute()'s own batching) rather than computeOldPath's
   * per-key round trips, which would mean up to 2×|FEATURE_REGISTRY| queries for a full trace.
   * Semantics match computeOldPath exactly, including its resolve-failure fallback to
   * isDarkFlag(key) for the flag-keyed half.
   */
  async computeOldPathAll(tenantId: string): Promise<Map<string, boolean>> {
    const [overrides, activeAddonRows, ent, isAlwaysEnforced] = await Promise.all([
      this.featureOverrides.allActive(tenantId),
      this.prisma.tenantAddon.findMany({
        where: { tenantId, active: true },
        select: { addonKey: true },
      }),
      this.entitlements.resolve(tenantId).catch((err) => {
        this.logger.error(
          `Old-path bulk entitlement resolution failed for tenant ${tenantId}`,
          err as Error,
        );
        return null;
      }),
      // Opus re-review of 3585e1ec (nit 2): must not let a throw here reject the whole
      // Promise.all — that would 500 the explain trace instead of returning a partial
      // answer. Only the addon-keyed dark-courtesy branch below consults this value;
      // every other key in the returned map stays fully accurate regardless.
      this.entitlements.isAlwaysEnforcedTenant(tenantId).catch((err) => {
        this.logger.error(
          `Old-path bulk isAlwaysEnforcedTenant check failed for tenant ${tenantId}`,
          err as Error,
        );
        return false;
      }),
    ]);
    const activeAddonSet = new Set(activeAddonRows.map((a) => a.addonKey));

    const result = new Map<string, boolean>();
    for (const feature of FEATURE_REGISTRY) {
      const override = overrides.get(feature.key);
      if (override === "GRANT") {
        result.set(feature.key, true);
        continue;
      }
      if (override === "DENY") {
        result.set(feature.key, false);
        continue;
      }

      const isAddonKeyed = feature.gate.via === "RequireAddon" || feature.gate.via === "guard";
      if (isAddonKeyed) {
        const active = activeAddonSet.has(feature.key);
        result.set(
          feature.key,
          active || (addonGateState(feature.key) === "dark" && !isAlwaysEnforced),
        );
        continue;
      }

      result.set(feature.key, ent ? allowsFlag(ent, feature.key) : isDarkFlag(feature.key));
    }
    return result;
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
