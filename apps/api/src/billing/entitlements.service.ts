import { Injectable, Logger } from "@nestjs/common";
import { TenantStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { addonSkuCode, planKeyFromEnum, PlanKey } from "./plan-catalog.constants";

/** Per-meter capacity caps; `null` means unlimited. */
export interface EntitlementCaps {
  seats: number | null;
  routes: number | null;
  scans: number | null;
  msgs: number | null;
}

/** The fully-resolved entitlement snapshot for a tenant. */
export interface Entitlements {
  tenantId: string;
  status: TenantStatus;
  planKey: PlanKey;
  planName: string;
  planVersionId: string | null;
  /** Granted feature-flag keys (plan featureFlags ∪ active-addon grantsFlags). */
  flags: string[];
  /** Active add-on SKU codes. */
  addons: string[];
  caps: EntitlementCaps;
  trialEndsAt: Date | null;
}

/** Compact subset carried in the JWT so the client can render gates without a round-trip. */
export interface EntitlementClaims {
  plan: PlanKey;
  flags: string[];
  addons: string[];
  seats: number | null;
  trialEnds: string | null;
}

interface CacheEntry {
  value: Entitlements;
  expiresAt: number;
}

/** Cache TTL: entitlement mutations (plan/addon changes) call {@link invalidate}. */
const CACHE_TTL_MS = 30_000;

/**
 * Resolves a tenant's entitlements (flags + caps + status) from its pinned
 * PlanVersion and active add-ons. This is the SERVER-SIDE AUTHORITY: the JWT
 * carries a snapshot for client rendering, but the PlanFlagGuard (added in the
 * plan-gating phase) re-resolves here so a revoked add-on takes effect within the
 * cache TTL even on an unexpired token.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
  ) {}

  /** Resolve (and cache) the full entitlement snapshot for a tenant. */
  async resolve(tenantId: string): Promise<Entitlements> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = await this.compute(tenantId);
    this.cache.set(tenantId, { value, expiresAt: now + CACHE_TTL_MS });
    if (this.cache.size > 1000) this.pruneExpired(now);
    return value;
  }

  /** Server-authoritative flag check (consumed by the PlanFlagGuard added in the plan-gating phase). */
  async hasFlag(tenantId: string, flagKey: string): Promise<boolean> {
    const ent = await this.resolve(tenantId);
    return ent.flags.includes(flagKey);
  }

  /** The compact claims embedded in the JWT / refreshed token. */
  toClaims(ent: Entitlements): EntitlementClaims {
    return {
      plan: ent.planKey,
      flags: ent.flags,
      addons: ent.addons,
      seats: ent.caps.seats,
      trialEnds: ent.trialEndsAt ? ent.trialEndsAt.toISOString() : null,
    };
  }

  /** Convenience: resolve → claims in one call (used at token issue). Never throws. */
  async claimsFor(tenantId: string | null): Promise<EntitlementClaims | null> {
    if (!tenantId) return null;
    try {
      return this.toClaims(await this.resolve(tenantId));
    } catch {
      return null; // entitlements must never block a login
    }
  }

  /** Evict a tenant's cached entitlements (call after any plan/addon mutation). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async compute(tenantId: string): Promise<Entitlements> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: true,
        addons: { where: { active: true } },
      },
    });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    const planKey =
      (tenant.subscription?.planKey as PlanKey | null) ?? planKeyFromEnum(tenant.plan);
    const version = await this.catalog.getVersionForTenant(tenant.planVersionId);

    // Resolve the definition for the tenant's planKey. If the pinned version has
    // no matching definition (e.g. a later published version dropped/renamed a
    // plan a subscription still names), fall back conservatively AND report the
    // effective plan so planKey/flags/caps stay internally consistent — never a
    // BUSINESS claim backed by STARTER caps.
    const exactDef = version.definitions.find((d) => d.planKey === planKey);
    const def =
      exactDef ??
      version.definitions.find((d) => d.planKey === "STARTER") ??
      version.definitions[0];
    if (!def) {
      throw new Error(`Plan catalog version ${version.id} has no plan definitions`);
    }
    if (!exactDef) {
      this.logger.warn(
        `Tenant ${tenantId}: planKey "${planKey}" absent from plan version ${version.id}; ` +
          `falling back to "${def.planKey}".`,
      );
    }
    const effectivePlanKey = def.planKey as PlanKey;

    // Catalog SKU metadata keyed by SKU code.
    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));

    // Resolve active add-ons → canonical SKU codes → catalog metadata.
    const activeCodes: string[] = [];
    const flags = new Set<string>(def.featureFlags);
    const capacity: Record<string, number> = { SEATS: 0, ROUTES: 0, SCANS: 0, MSGS: 0 };

    for (const addon of tenant.addons) {
      const code = addonSkuCode(addon);
      if (!code) continue;
      activeCodes.push(code);
      const meta = skuByCode.get(code);
      if (!meta) continue;
      for (const flag of meta.grantsFlags) flags.add(flag);
      if (meta.meteredKey && meta.capacityPerUnit) {
        capacity[meta.meteredKey] += addon.quantity * meta.capacityPerUnit;
      }
    }

    const cap = (included: number | null, meter: string): number | null =>
      included == null ? null : included + capacity[meter];

    return {
      tenantId,
      status: tenant.status,
      planKey: effectivePlanKey,
      planName: def.name,
      planVersionId: version.id,
      flags: [...flags],
      addons: [...new Set(activeCodes)],
      caps: {
        seats: cap(def.seatsIncluded ?? null, "SEATS"),
        routes: cap(def.routesConcurrent ?? null, "ROUTES"),
        scans: cap(def.scansIncluded ?? null, "SCANS"),
        msgs: cap(def.msgsIncluded ?? null, "MSGS"),
      },
      trialEndsAt: tenant.trialEndsAt,
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
