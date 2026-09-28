/**
 * SA-540 (owner ruling 2026-09-28, "On for everyone") — real-Postgres pin that the
 * `orders_inline_returns` default grant is honoured at RUNTIME by real AddonService +
 * EntitlementsService + FeatureOverrideService + PlanCatalogService collaborators (not the
 * mocked harness in addon-default-grant.spec.ts). Drives a real AddonGuard over them too.
 *
 * Plan/flag.returns note: `ensurePublishedCatalog` (src/testing/ensure-published-catalog.ts)
 * always creates plan definitions with `featureFlags: []`, and a pre-existing PUBLISHED catalog
 * (e.g. from `local:seed`) is reused as-is and cannot be relied on to carry `flag.returns` on any
 * plan. So instead of pinning a tenant to a plan that carries the flag, each case gets
 * `flag.returns` into the tenant's effective requirement set the same way a real grant would:
 * a GRANT `TenantFeatureOverride` row on featureKey "flag.returns" (a registered feature key,
 * see feature-registry.ts:569). `isDefaultGrantedAddon`'s `requires` check folds GRANT/DENY
 * overrides into its `effective` set alongside `ent.flags` (addon.service.ts `defaultGrantedKeys`
 * fetches overrides for `[key, ...defaultGrantRequirementKeys]`), so a GRANT on "flag.returns" is
 * exactly equivalent, for this predicate, to the flag being present in the plan's featureFlags.
 *
 * Only Stripe / BillingEventService / EntitlementAuthority / FeatureResolverService are stubbed
 * (boundaries `sa385b` also stubs); PrismaService, EntitlementsService, FeatureOverrideService,
 * PlanCatalogService and AddonGuard are all real, over a real Postgres.
 */
import { randomUUID } from "crypto";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders_inline_returns";
const FLAG = "flag.returns";

describeDb(
  "SA-540 — orders_inline_returns default grant (real Postgres, real collaborators)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let addons: AddonService;
    let entitlements: EntitlementsService;
    let featureOverrides: FeatureOverrideService;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
    // Set only when this spec created the catalog (a fresh CI DB has none, SA-398).
    let createdVersionId: string | undefined;

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
      createdVersionId = await ensurePublishedCatalog(
        prisma,
        {
          plans: [{ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 }],
          addons: [],
        },
        "addon-default-grant.db.spec.ts",
      );

      const catalog = new PlanCatalogService(prisma as any);
      featureOverrides = new FeatureOverrideService(prisma as any);
      entitlements = new EntitlementsService(prisma as any, catalog, featureOverrides);
      addons = new AddonService(
        prisma as any,
        {} as any, // stripe (boundary, unused by hasAddon/getActiveAddons)
        entitlements,
        catalog,
        { invalidate: jest.fn() } as any, // featureResolver (cache invalidate only)
        { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any, // authority
        { emit: jest.fn() } as any, // events (boundary, unused here)
        featureOverrides,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      await dropPublishedCatalog(prisma, createdVersionId);
      await prisma?.$disconnect();
      await pool?.end();
    });

    /** A throwaway ACTIVE tenant on the GROWTH plan (whose catalog featureFlags are always []). */
    async function throwawayTenant(label: string): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa540-${run}-${seq}-${label}`,
        "addon-default-grant.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          stripeSubId: `sub_sa540_${run}_${seq}`,
          discount: 0,
        } as any,
      });
      return t.id;
    }

    function guardFor(key: string, tenantId: string) {
      const reflector = { getAllAndOverride: jest.fn().mockReturnValue([key]) };
      const guard = new AddonGuard(
        reflector as unknown as Reflector,
        addons,
        entitlements,
        featureOverrides,
      );
      const ctx = {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { tenantId },
            method: "POST",
            url: "/returns/inline/quote",
          }),
        }),
      } as unknown as ExecutionContext;
      return () => guard.canActivate(ctx);
    }

    async function grantFlagReturns(tenantId: string) {
      await featureOverrides.create({
        tenantId,
        featureKey: FLAG,
        effect: "GRANT",
        reason: "SA-540 db.spec — fixture grant of flag.returns (no published plan carries it)",
        expiresAt: null,
        createdById: null,
      });
    }

    async function denyInlineReturns(tenantId: string) {
      await featureOverrides.create({
        tenantId,
        featureKey: KEY,
        effect: "DENY",
        reason: "SA-540 db.spec — fixture deny of orders_inline_returns",
        expiresAt: null,
        createdById: null,
      });
    }

    it("(1) no TenantAddon row + flag.returns granted → hasAddon true, getActiveAddons includes it, guard resolves true", async () => {
      const t = await throwawayTenant("case1");
      const before = await prisma.tenantAddon.count({ where: { tenantId: t } });

      await grantFlagReturns(t);

      await expect(addons.hasAddon(t, KEY)).resolves.toBe(true);
      await expect(addons.getActiveAddons(t)).resolves.toContain(KEY);
      await expect(guardFor(KEY, t)()).resolves.toBe(true);

      const after = await prisma.tenantAddon.count({ where: { tenantId: t } });
      expect(after).toBe(before);
      expect(after).toBe(0);
    });

    it("(2) same as (1) plus an active DENY override on orders_inline_returns → hasAddon false, key absent, guard throws Forbidden", async () => {
      const t = await throwawayTenant("case2");
      const before = await prisma.tenantAddon.count({ where: { tenantId: t } });

      await grantFlagReturns(t);
      await denyInlineReturns(t);

      await expect(addons.hasAddon(t, KEY)).resolves.toBe(false);
      await expect(addons.getActiveAddons(t)).resolves.not.toContain(KEY);
      await expect(guardFor(KEY, t)()).rejects.toBeInstanceOf(ForbiddenException);

      const after = await prisma.tenantAddon.count({ where: { tenantId: t } });
      expect(after).toBe(before);
      expect(after).toBe(0);
    });

    it("(3) no flag.returns (and no GRANT) → hasAddon false, guard throws Forbidden", async () => {
      const t = await throwawayTenant("case3");
      const before = await prisma.tenantAddon.count({ where: { tenantId: t } });

      // No override created at all — the GROWTH plan fixture's featureFlags are [].
      await expect(addons.hasAddon(t, KEY)).resolves.toBe(false);
      await expect(addons.getActiveAddons(t)).resolves.not.toContain(KEY);
      await expect(guardFor(KEY, t)()).rejects.toBeInstanceOf(ForbiddenException);

      const after = await prisma.tenantAddon.count({ where: { tenantId: t } });
      expect(after).toBe(before);
      expect(after).toBe(0);
    });

    it("(4) no writes across cases 1-3: total TenantAddon rows for all three tenants stayed zero the whole time (computed at read time, never persisted)", async () => {
      const rows = await prisma.tenantAddon.findMany({ where: { tenantId: { in: tenantIds } } });
      expect(rows).toHaveLength(0);
    });
  },
);
