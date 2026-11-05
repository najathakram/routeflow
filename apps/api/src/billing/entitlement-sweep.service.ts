import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { EntitlementsMode } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { creditLimitCheckApplies } from "../orders/credit-limit-guard";
import { AddonAccessService } from "./addon-access";
import { AddonService } from "./addon.service";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { FEATURE_REGISTRY, gateVia } from "./feature-registry";
import { heldAddonKeys } from "./fulfilment-capability";
import { computeServedFlags, isCourtesyServed, isPlanFlagEnforcementOn } from "./plan-flag-policy";

/**
 * FG-1 WP1 (R10): the read-only entitlement sweep. For every tenant it answers, per gated registry
 * key, what today's guards say (`old`), what the resolver says (`effective`), what the strict
 * reading says (`strict`) and what the two client projections say (`clientAddon` for add-on keys =
 * `/tenants/me/addons`, `clientFlag` for flag keys = `subscription.flags`). Plus one row per
 * distinct multi-key `@RequireAddon` gate set, decided by the real `decideAddonAccess`.
 *
 * Every row also carries `courtesy` (SA-1100 §3): the served answer came from the courtesy allow,
 * from the ONE predicate `isCourtesyServed` in `plan-flag-policy.ts` (WP2's resolver imports the
 * same function). The scripts cannot import the API, so the bit travels on the wire.
 *
 * Nothing in the output names a business: the tenant id is a stable one-way hash, the cursor is
 * that same hash, and `inputsHash` covers plan, plan version, add-on rows and override rows (each
 * override with whether it is still live at sweep time) so the compare script can tell "the answer
 * moved" from "the inputs moved".
 *
 * Every tenant is computed fresh: its entitlement, override and resolver caches are dropped
 * first (a cache drop, not a write). Read-only.
 */

/** The distinct multi-key `@RequireAddon(...)` sets in the controllers; pinned by a source scan. */
export const MULTI_KEY_ADDON_SETS: readonly (readonly string[])[] = [
  ["recurring_routes", "order_delivery", "developer_mode"],
  ["order_delivery", "developer_mode"],
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Stable one-way hash: the only tenant identifier that leaves the API through the sweep. */
export const hashTenantId = (id: string): string =>
  createHash("sha256").update(`rf-entitlement-sweep:v1:${id}`).digest("hex").slice(0, 24);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export interface SweepBits {
  old: boolean;
  effective: boolean;
  /** Equal to `effective` until WP2 separates courtesy from strict inside the resolver. */
  strict: boolean;
  /** `/tenants/me/addons` verdict; null for a key that is not add-on keyed. */
  clientAddon: boolean | null;
  /** `subscription.flags` verdict; null for an add-on keyed key. */
  clientFlag: boolean | null;
  /** The served answer (`old`) came from the courtesy allow: `isCourtesyServed`, SA-1100 §3. */
  courtesy: boolean;
}

export interface SweepTenant {
  id: string;
  class: string;
  inputsHash: string;
  keys: Record<string, SweepBits>;
  sets: Record<string, Omit<SweepBits, "clientFlag">>;
  error?: "resolve_failed";
}

export interface SweepPage {
  mode?: EntitlementsMode;
  /** Page 1 only, when the mode could not be read: `mode` is then absent, never a guessed "shadow". */
  modeReadFailed?: true;
  planFlagEnforcement?: "on" | "off";
  tenants: SweepTenant[];
  nextCursor: string | null;
}

@Injectable()
export class EntitlementSweepService {
  private readonly logger = new Logger(EntitlementSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly resolver: FeatureResolverService,
    private readonly authority: EntitlementAuthority,
    private readonly modeService: EntitlementsModeService,
    private readonly addons: AddonService,
    private readonly addonAccess: AddonAccessService,
  ) {}

  async sweep(opts: { cursor?: string; limit?: number }): Promise<SweepPage> {
    const asked = Math.trunc(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(asked, 1), MAX_LIMIT);
    const all = await this.prisma.tenant.findMany({
      select: { id: true, class: true },
      orderBy: { id: "asc" },
    });
    let start = 0;
    if (opts.cursor) {
      const at = all.findIndex((t) => hashTenantId(t.id) === opts.cursor);
      if (at < 0) throw new BadRequestException("Unknown cursor");
      start = at + 1;
    }
    const slice = all.slice(start, start + limit);

    const page: SweepPage = { tenants: [], nextCursor: null };
    if (!opts.cursor) {
      // Read without the fail-open fallback: a failed read must not look like "shadow".
      try {
        page.mode = await this.modeService.getModeStrict();
      } catch (err) {
        this.logger.error("Sweep: the entitlements mode could not be read", err as Error);
        page.modeReadFailed = true;
      }
      page.planFlagEnforcement = isPlanFlagEnforcementOn() ? "on" : "off";
    }
    for (const t of slice) page.tenants.push(await this.sweepTenant(t.id, String(t.class)));
    if (start + limit < all.length && slice.length > 0) {
      page.nextCursor = hashTenantId(slice[slice.length - 1].id);
    }
    return page;
  }

  private async sweepTenant(tenantId: string, tenantClass: string): Promise<SweepTenant> {
    // Fresh compute: drop the per-process caches for this tenant (nothing is written).
    this.entitlements.invalidate(tenantId);
    this.featureOverrides.invalidate(tenantId);
    this.resolver.invalidate(tenantId);

    const id = hashTenantId(tenantId);
    const sweptAt = Date.now();
    const [addonRows, rawOverrideRows] = await Promise.all([
      this.prisma.tenantAddon.findMany({
        where: { tenantId },
        select: { addonKey: true, sku: true, quantity: true, active: true, isComp: true },
        orderBy: { addonKey: "asc" },
      }),
      this.prisma.tenantFeatureOverride.findMany({
        where: { tenantId, revokedAt: null },
        select: { featureKey: true, effect: true, kind: true, expiresAt: true },
        orderBy: [{ featureKey: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    // SA-1100 §3: hash whether each override is still live at sweep time. `expiresAt` alone is
    // constant while an override lapses, so the answer would move under an unchanged hash.
    const overrideRows = rawOverrideRows.map((r) => ({
      ...r,
      live: r.expiresAt == null || r.expiresAt.getTime() > sweptAt,
    }));
    const resolved = await this.resolver.resolve(tenantId);
    if (!resolved) {
      this.logger.error("Sweep: the resolver could not resolve a tenant");
      return {
        id,
        class: tenantClass,
        inputsHash: digest({ addonRows, overrideRows }),
        keys: {},
        sets: {},
        error: "resolve_failed",
      };
    }
    const inputsHash = digest({
      plan: resolved.planKey,
      version: resolved.catalogVersionId,
      addonRows,
      overrideRows,
    });

    const [oldAll, ent, overrides] = await Promise.all([
      this.authority.computeOldPathAll(tenantId),
      this.entitlements.resolve(tenantId),
      this.featureOverrides.allActive(tenantId),
    ]);
    const held = await heldAddonKeys(this.addons, this.featureOverrides, tenantId);
    const served = new Set(computeServedFlags(ent.planKey, ent.flags, overrides));

    const keys: Record<string, SweepBits> = {};
    for (const feature of FEATURE_REGISTRY) {
      if (feature.gate.via === "none") continue;
      const key = feature.key;
      const effective = resolved.byKey.get(key)?.effective ?? false;
      const addonKeyed = gateVia(key) === "RequireAddon" || gateVia(key) === "guard";
      // SA-1099 §2: the credit check is not the plan-flag courtesy `computeOldPathAll` models.
      // It is the guard's own rule over the guard's own read (`entitlements.hasFlag`).
      const old =
        key === "flag.credit_limits"
          ? creditLimitCheckApplies(
              process.env.PLAN_FLAG_ENFORCEMENT,
              await this.entitlements.hasFlag(tenantId, key),
            )
          : (oldAll.get(key) ?? false);
      keys[key] = {
        old,
        effective,
        // the resolver's own strict answer (FG-1 WP2): the owner's rule with no courtesy
        strict: resolved.byKey.get(key)?.strict ?? false,
        clientAddon: addonKeyed ? held.has(key) : null,
        clientFlag: addonKeyed ? null : served.has(key),
        courtesy: isCourtesyServed({
          keys: [key],
          planKey: ent.planKey,
          planFlags: ent.flags,
          overrides,
          held,
        }),
      };
    }

    const sets: SweepTenant["sets"] = {};
    for (const setKeys of MULTI_KEY_ADDON_SETS) {
      const decision = await this.addonAccess.decide(tenantId, [...setKeys]);
      const effective = setKeys.some((k) => resolved.byKey.get(k)?.effective === true);
      sets[setKeys.join("|")] = {
        old: decision.outcome !== "denied",
        effective,
        strict: setKeys.some((k) => resolved.byKey.get(k)?.strict === true),
        clientAddon: setKeys.some((k) => held.has(k)),
        courtesy: isCourtesyServed({
          keys: setKeys,
          planKey: ent.planKey,
          planFlags: ent.flags,
          overrides,
          held,
        }),
      };
    }
    return { id, class: tenantClass, inputsHash, keys, sets };
  }
}
