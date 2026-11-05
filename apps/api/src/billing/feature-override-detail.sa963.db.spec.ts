/**
 * SA-963 A-1 (F13) - real Postgres. The resolver fills an override's kind, reason and end date beside the verdict so the Feature
 * Console's two chips and its Details panel read real data. The unit rows (feature-override-detail.sa963.spec.ts) pin each piece
 * over mocks; what only a real database shows is pinned here, with the REAL FeatureOverrideService, FeatureResolverService and
 * FeaturePreviewService over rows written through the real `create` / `revoke`:
 *
 *   F-1  GRANT/COMP with an end date and a reason -> detail filled, ISO end date
 *   F-2  GRANDFATHER with no end date -> expiresAt null
 *   F-3  DENY with reason + end date -> source OVERRIDE_DENY, same detail
 *   F-4  a row past its end date, never revoked -> falls through: no detail, no past date, verdict unchanged
 *   F-5  revoke, then read -> detail gone
 *   F-6  preview DENY over a stored dated GRANT -> before has the stored date, after has the request's
 *   F-6b preview GRANT with no end date over a stored dated GRANT -> after.expiresAt null
 *   F-7  the same tenant with and without the fill: every key's effective, source and charged, and the preview `changed`, identical
 *   F-10 the override lookup fails -> the same fail-open (no throw, verdict from the plan)
 *
 * Entitlements are a stub (a plan with no flags); everything between Prisma and the resolver is real. Throwaway `qa-*` tenants.
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { FEATURE_REGISTRY } from "./feature-registry";
import { FeatureOverrideService } from "./feature-override.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { PlanCatalogService } from "./plan-catalog.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "flag.estimates";
const OTHER = "flag.reports";
const DAY = 24 * 3600 * 1000;

describeDb(
  "SA-963 A-1 - override kind, reason and end date on the resolver (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let overrides: FeatureOverrideService;
    let resolver: FeatureResolverService;
    let resolverNoDetail: FeatureResolverService;
    let preview: FeaturePreviewService;
    let previewNoDetail: FeaturePreviewService;
    let createdVersionId: string | undefined;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;

    const entitlements = {
      resolve: async () => ({ planKey: "GROWTH", planVersionId: null, flags: [], addons: [] }),
    } as any;
    const featureConfig = {
      getState: async () => ({ value: "unset", effective: "unset" }),
    } as any;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      const url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
      createdVersionId = await ensurePublishedCatalog(
        prisma,
        { plans: [{ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 }], addons: [] },
        "feature-override-detail.sa963.db.spec.ts",
      );
      const catalog = new PlanCatalogService(prisma as any);
      overrides = new FeatureOverrideService(prisma as any);
      resolver = new FeatureResolverService(entitlements, overrides, catalog, prisma as any);
      preview = new FeaturePreviewService(
        entitlements,
        overrides,
        catalog,
        prisma as any,
        featureConfig,
      );
      // The same collaborators with the detail read returning nothing: the world before this change.
      const noDetail = {
        allActive: (t: string) => overrides.allActive(t),
        activeDetail: async () => new Map(),
      } as any;
      resolverNoDetail = new FeatureResolverService(entitlements, noDetail, catalog, prisma as any);
      previewNoDetail = new FeaturePreviewService(
        entitlements,
        noDetail,
        catalog,
        prisma as any,
        featureConfig,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      await dropPublishedCatalog(prisma, createdVersionId);
      await prisma?.$disconnect();
      await pool?.end();
    });

    async function tenant(label: string): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa963-${run}-${seq}-${label}`,
        "feature-override-detail.sa963.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          stripeSubId: `sub_sa963_${run}_${seq}`,
          discount: 0,
        } as any,
      });
      return t.id;
    }

    const grant = (
      tenantId: string,
      over: Partial<Parameters<FeatureOverrideService["create"]>[0]> = {},
    ) =>
      overrides.create({
        tenantId,
        featureKey: KEY,
        effect: "GRANT",
        kind: "COMP",
        reason: "pilot month",
        expiresAt: new Date(Date.now() + 10 * DAY),
        createdById: null,
        ...over,
      });
    const keyOf = async (tenantId: string, key = KEY) =>
      (await resolver.resolve(tenantId))!.byKey.get(key)!;

    it("F-1: a dated COMP GRANT -> kind, reason and an ISO end date", async () => {
      const t = await tenant("f1");
      const ends = new Date(Date.now() + 10 * DAY);
      await grant(t, { expiresAt: ends });
      expect(await keyOf(t)).toMatchObject({
        effective: true,
        source: "OVERRIDE_GRANT",
        kind: "COMP",
        reason: "pilot month",
        expiresAt: ends.toISOString(),
        charged: false,
      });
    });

    it("F-2: a GRANDFATHER GRANT with no end date -> expiresAt null", async () => {
      const t = await tenant("f2");
      await grant(t, { kind: "GRANDFATHER", reason: "kept", expiresAt: null });
      const r = await keyOf(t);
      expect(r).toMatchObject({ source: "OVERRIDE_GRANT", kind: "GRANDFATHER", reason: "kept" });
      expect(r.expiresAt).toBeNull();
    });

    it("F-3: a DENY with a reason and an end date -> OVERRIDE_DENY with the same detail", async () => {
      const t = await tenant("f3");
      const ends = new Date(Date.now() + 3 * DAY);
      await grant(t, { effect: "DENY", kind: "SUPPORT", reason: "abuse review", expiresAt: ends });
      expect(await keyOf(t)).toMatchObject({
        effective: false,
        source: "OVERRIDE_DENY",
        kind: "SUPPORT",
        reason: "abuse review",
        expiresAt: ends.toISOString(),
      });
    });

    it("F-4 (guard): an expired, unrevoked row falls through: no detail, no past date, same verdict as no row", async () => {
      const t = await tenant("f4");
      await prisma.tenantFeatureOverride.create({
        data: {
          tenantId: t,
          featureKey: KEY,
          effect: "GRANT",
          kind: "COMP",
          reason: "old pilot",
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const bare = await tenant("f4bare");
      const r = await keyOf(t);
      expect(r).not.toHaveProperty("kind");
      expect(r).not.toHaveProperty("reason");
      expect(r).not.toHaveProperty("expiresAt");
      const none = await keyOf(bare);
      expect([r.effective, r.source]).toEqual([none.effective, none.source]);
    });

    it("F-5 (guard): revoke, then read -> the detail is gone", async () => {
      const t = await tenant("f5");
      const row = await grant(t);
      expect(await keyOf(t)).toHaveProperty("reason", "pilot month");
      await overrides.revoke(t, row.id);
      resolver.invalidate(t);
      const r = await keyOf(t);
      expect(r).not.toHaveProperty("reason");
      expect(r.source).not.toMatch(/^OVERRIDE_/);
    });

    it("F-6: preview DENY over a stored dated GRANT -> before has the stored date, after the request's", async () => {
      const t = await tenant("f6");
      const stored = new Date(Date.now() + 10 * DAY);
      const asked = new Date(Date.now() + 2 * DAY);
      await grant(t, { expiresAt: stored });
      const res = await preview.preview(t, {
        overrides: [
          {
            featureKey: KEY,
            effect: "DENY",
            kind: "SUPPORT",
            reason: "abuse",
            expiresAt: asked.toISOString(),
          },
        ],
      } as any);
      const before = res.before.find((f) => f.key === KEY)!;
      const after = res.after.find((f) => f.key === KEY)!;
      expect(before.detail).toMatchObject({ kind: "COMP", expiresAt: stored.toISOString() });
      expect(after.source).toBe("OVERRIDE_DENY");
      expect(after.detail).toMatchObject({
        kind: "SUPPORT",
        reason: "abuse",
        expiresAt: asked.toISOString(),
      });
    });

    it("F-6b: preview GRANT with no end date over a stored dated GRANT -> after.expiresAt null", async () => {
      const t = await tenant("f6b");
      await grant(t);
      const res = await preview.preview(t, {
        overrides: [{ featureKey: KEY, effect: "GRANT", reason: "keep it" }],
      } as any);
      const after = res.after.find((f) => f.key === KEY)!;
      expect(after.detail.expiresAt).toBeNull();
      expect(after.detail).toMatchObject({ kind: "COMP", reason: "keep it" });
    });

    it("F-7 (guard): with and without the fill, every key's effective/source/charged and the preview `changed` are identical", async () => {
      const t = await tenant("f7");
      await grant(t);
      await grant(t, { featureKey: OTHER, effect: "DENY", kind: "SUPPORT", reason: "x" });
      const a = (await resolver.resolve(t))!;
      const b = (await resolverNoDetail.resolve(t))!;
      expect(FEATURE_REGISTRY.length).toBeGreaterThan(5);
      for (const f of FEATURE_REGISTRY) {
        const x = a.byKey.get(f.key)!;
        const y = b.byKey.get(f.key)!;
        expect([x.key, x.effective, x.source, x.charged]).toEqual([
          y.key,
          y.effective,
          y.source,
          y.charged,
        ]);
      }
      const req = { overrides: [{ featureKey: OTHER, effect: "GRANT", reason: "y" }] } as any;
      const pa = await preview.preview(t, req);
      const pb = await previewNoDetail.preview(t, req);
      expect(pa.changed).toEqual(pb.changed);
      expect(pa.after.map((f) => [f.key, f.resolver, f.source])).toEqual(
        pb.after.map((f) => [f.key, f.resolver, f.source]),
      );
    });

    it("F-10 (guard): the override lookup fails -> no throw, the verdict comes from the plan like any key with no override", async () => {
      const t = await tenant("f10");
      await grant(t);
      const broken = new FeatureOverrideService({
        tenantFeatureOverride: {
          findMany: async () => {
            throw new Error("db down");
          },
        },
      } as any);
      const failing = new FeatureResolverService(
        entitlements,
        broken,
        new PlanCatalogService(prisma as any),
        prisma as any,
      );
      const r = (await failing.resolve(t))!.byKey.get(KEY)!;
      expect(r.source).not.toMatch(/^OVERRIDE_/);
      expect(r).not.toHaveProperty("reason");
    });
  },
);
