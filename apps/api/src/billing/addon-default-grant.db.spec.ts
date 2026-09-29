/**
 * SA-540 (owner ruling 2026-09-28, "On for everyone") — real-Postgres pin that the
 * `orders_inline_returns` default grant is honoured at RUNTIME by real AddonService +
 * EntitlementsService + FeatureOverrideService + PlanCatalogService collaborators (not the
 * mocked harness in addon-default-grant.spec.ts). Drives a real AddonGuard over them too.
 *
 * Plan/flag.returns (lead folds F1/F2 on #2689): a seeded DB's PUBLISHED catalog is not a fixed
 * input (catalog v1 gives GROWTH flag.returns; the ensurePublishedCatalog fixture gives no plan
 * any flag). So every tenant is PINNED (Tenant.planVersionId, which EntitlementsService.resolve
 * reads) to one of two spec-owned PlanVersions whose GROWTH does / does not carry flag.returns:
 *   - case 5 is the production path itself: the PLAN grants flag.returns, no override, no rows;
 *   - cases 1–2 reach flag.returns through a GRANT override on it instead (`requires` folds
 *     GRANT/DENY overrides into its set alongside ent.flags);
 *   - case 3 (#2700, lead F1 / SA-559d) is two UNCONDITIONAL cases on spec-unique plan keys, so no
 *     DB's published catalog can decide them: (3a) a key no published version carries ⇒ the
 *     "flags gain forward" union adds nothing ⇒ not granted; (3b) the spec publishes its OWN
 *     version carrying flag.returns ⇒ pinned ∪ published grants it, and a DENY then removes it.
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
    // Lead fold F1/F2 on #2689: every tenant is PINNED to a spec-owned PlanVersion, so no case
    // depends on what a seeded DB's published catalog grants (catalog v1 gives GROWTH
    // flag.returns). One version's GROWTH carries flag.returns, the other's does not.
    let versionWithReturns: string;
    let versionWithoutReturns: string;
    // #2700: spec-owned versions made by case 3a/3b (deleted in afterAll with the others).
    const extraVersionIds: string[] = [];

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
      const specVersion = async (featureFlags: string[]) => {
        // A unique, obviously-synthetic version number; never PUBLISHED, so nothing else sees it.
        const version = 1_900_000_000 + Math.floor(Math.random() * 99_999_999);
        const v = await prisma.planVersion.create({
          data: {
            version,
            notes: "addon-default-grant.db.spec.ts (spec-owned, deleted in afterAll)",
            definitions: {
              create: [
                {
                  planKey: "GROWTH",
                  name: "Growth",
                  monthlyPrice: 249,
                  isCustom: false,
                  featureFlags,
                },
              ],
            },
          },
        });
        return v.id;
      };
      versionWithReturns = await specVersion([FLAG]);
      versionWithoutReturns = await specVersion([]);

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
      // Spec-owned versions go after their tenants (definitions cascade).
      await prisma.planVersion.deleteMany({
        where: {
          id: {
            in: [versionWithReturns, versionWithoutReturns, ...extraVersionIds].filter(Boolean),
          },
        },
      });
      await dropPublishedCatalog(prisma, createdVersionId);
      await prisma?.$disconnect();
      await pool?.end();
    });

    /**
     * A throwaway ACTIVE GROWTH tenant PINNED to a spec-owned PlanVersion: `withReturns` decides
     * whether its plan's featureFlags carry flag.returns (the production grant path).
     */
    async function throwawayTenant(label: string, withReturns = false): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa540-${run}-${seq}-${label}`,
        "addon-default-grant.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.ACTIVE,
          planVersionId: withReturns ? versionWithReturns : versionWithoutReturns,
        } as any,
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          planVersionId: withReturns ? versionWithReturns : versionWithoutReturns,
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

    /** #2700 (lead F1, SA-559d): a spec-owned PlanVersion with ONE definition under `planKey`. */
    async function specVersionFor(planKey: string, featureFlags: string[], status?: "PUBLISHED") {
      const version = 1_900_000_000 + Math.floor(Math.random() * 99_999_999);
      const now = new Date();
      const v = await prisma.planVersion.create({
        data: {
          version,
          ...(status ? { status, publishedAt: now, effectiveAt: now } : {}),
          notes: "addon-default-grant.db.spec.ts #2700 (spec-owned, deleted in afterAll)",
          definitions: {
            create: [{ planKey, name: planKey, monthlyPrice: 1, isCustom: false, featureFlags }],
          },
        },
      });
      extraVersionIds.push(v.id);
      return v.id;
    }

    /** A throwaway tenant on a spec-unique `planKey`, pinned to `versionId`. */
    async function tenantOnPlan(label: string, planKey: string, versionId: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa540-${run}-${seq}-${label}`,
        "addon-default-grant.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.ACTIVE,
          planVersionId: versionId,
        } as any,
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey,
          planVersionId: versionId,
          stripeSubId: `sub_sa540_${run}_${seq}`,
          discount: 0,
        } as any,
      });
      return t.id;
    }

    it("(3a) #2700 NEGATIVE, any DB: a plan key no published catalog carries ⇒ the union adds nothing ⇒ no flag.returns, no key, guard throws", async () => {
      // Spec-unique key: no published version (seeded or fresh) has a definition for it, so the
      // union has no forward row — plan absence holds on EVERY DB, unconditionally.
      const planKey = `QA2700ABSENT${run.toUpperCase()}`;
      const t = await tenantOnPlan("case3a", planKey, await specVersionFor(planKey, []));

      await expect(entitlements.hasFlag(t, FLAG)).resolves.toBe(false);
      await expect(addons.hasAddon(t, KEY)).resolves.toBe(false);
      await expect(addons.getActiveAddons(t)).resolves.not.toContain(KEY);
      await expect(guardFor(KEY, t)()).rejects.toBeInstanceOf(ForbiddenException);
      expect(await prisma.tenantAddon.count({ where: { tenantId: t } })).toBe(0);
    });

    it("(3b) #2700 UNION + DENY, any DB: pinned (no flag) ∪ a spec-PUBLISHED source carrying flag.returns ⇒ granted; a DENY on flag.returns ⇒ denied", async () => {
      const planKey = `QA2700UNION${run.toUpperCase()}`;
      // The spec controls the published source: demote whatever is PUBLISHED for this case only,
      // publish its own version (the SAME spec-unique key, carrying flag.returns), restore after.
      const toRestore = await prisma.planVersion.findMany({
        where: { status: "PUBLISHED" },
        select: { id: true, publishedAt: true, effectiveAt: true },
      });
      await prisma.planVersion.updateMany({
        where: { id: { in: toRestore.map((v) => v.id) } },
        data: { status: "SUPERSEDED" },
      });
      try {
        const pinned = await specVersionFor(planKey, []);
        const publishedId = await specVersionFor(planKey, [FLAG], "PUBLISHED");
        const t = await tenantOnPlan("case3b", planKey, pinned);

        const ent = await entitlements.resolve(t);
        expect(ent.planVersionId).toBe(pinned); // never re-pinned
        expect(ent.flags).toContain(FLAG); // gained forward from the spec-published version
        await expect(addons.hasAddon(t, KEY)).resolves.toBe(true);
        await expect(addons.getActiveAddons(t)).resolves.toContain(KEY);
        await expect(guardFor(KEY, t)()).resolves.toBe(true);

        await featureOverrides.create({
          tenantId: t,
          featureKey: FLAG,
          effect: "DENY",
          reason: "#2700 db.spec — fixture deny of flag.returns over a union grant",
          expiresAt: null,
          createdById: null,
        });
        await expect(addons.hasAddon(t, KEY)).resolves.toBe(false);
        await expect(addons.getActiveAddons(t)).resolves.not.toContain(KEY);
        await expect(guardFor(KEY, t)()).rejects.toBeInstanceOf(ForbiddenException);
        expect(await prisma.tenantAddon.count({ where: { tenantId: t } })).toBe(0);
        expect(publishedId).toBeTruthy();
      } finally {
        // Demote the spec's own PUBLISHED version FIRST (even when an assertion failed above), so
        // exactly the original row(s) end up PUBLISHED again.
        await prisma.planVersion.updateMany({
          where: { id: { in: extraVersionIds }, status: "PUBLISHED" },
          data: { status: "SUPERSEDED" },
        });
        for (const v of toRestore) {
          await prisma.planVersion.update({
            where: { id: v.id },
            data: { status: "PUBLISHED", publishedAt: v.publishedAt, effectiveAt: v.effectiveAt },
          });
        }
      }
    });

    it("(5) THE production path: the PLAN grants flag.returns, no override, no rows → hasAddon, getActiveAddons and the real AddonGuard all hold it with 0 rows; a DENY on flag.returns then removes it everywhere", async () => {
      const t = await throwawayTenant("case5-plan", true);

      await expect(addons.hasAddon(t, KEY)).resolves.toBe(true);
      await expect(addons.getActiveAddons(t)).resolves.toContain(KEY);
      await expect(guardFor(KEY, t)()).resolves.toBe(true);
      expect(await prisma.tenantAddon.count({ where: { tenantId: t } })).toBe(0);

      // SA-540 M2: `requires` honours overrides — a DENY on the plan flag removes inline returns.
      await featureOverrides.create({
        tenantId: t,
        featureKey: FLAG,
        effect: "DENY",
        reason: "SA-540 db.spec — fixture deny of flag.returns over a plan grant",
        expiresAt: null,
        createdById: null,
      });
      await expect(addons.hasAddon(t, KEY)).resolves.toBe(false);
      await expect(addons.getActiveAddons(t)).resolves.not.toContain(KEY);
      await expect(guardFor(KEY, t)()).rejects.toBeInstanceOf(ForbiddenException);
      expect(await prisma.tenantAddon.count({ where: { tenantId: t } })).toBe(0);
    });

    it("(4) no writes across every case: total TenantAddon rows for all the spec's tenants stayed zero the whole time (computed at read time, never persisted)", async () => {
      const rows = await prisma.tenantAddon.findMany({ where: { tenantId: { in: tenantIds } } });
      expect(rows).toHaveLength(0);
    });
  },
);
