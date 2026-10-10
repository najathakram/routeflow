/**
 * DB-lane spec for prisma/publish-plan-catalog-v13.ts's `publishV13(prisma)` (#2700, SA-559(1)) — a
 * mirror of the previous publisher's DB spec's four cases (idempotent noop, create + publish, DRAFT
 * resume, mismatched-DRAFT refuse) plus SA-559's "no tenant is re-pinned" case. The pure data
 * (V13_DEFINITIONS, buildV13Rows) is covered without a DB by plan-catalog-v13.spec.ts.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * AUTHORED WITHOUT A DATABASE (the MacBook lane runs no DB lane): typechecked, NOT executed here.
 * F2 (Mac mini) runs it at the PR sha; do not treat it as passing until that run is posted.
 *
 * Same global-singleton handling as the previous spec: `withNoPublishedVersion()` demotes whatever
 * is PUBLISHED for the length of one test and restores it in a `finally`; every row a test creates
 * is deleted (or demoted) before it returns, with `afterAll` as a final safety net.
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { publishV13 } from "../../prisma/publish-plan-catalog-v13";
import {
  V13_ADDON_SEEDS,
  V13_DEFINITIONS,
  buildV13Rows,
} from "../../prisma/plan-catalog-v13.definitions";

const WITH_CATALOG = {
  definitions: { orderBy: { sortOrder: "asc" } },
  addonSkus: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.PlanVersionInclude;
type CatalogVersion = Prisma.PlanVersionGetPayload<{ include: typeof WITH_CATALOG }>;

describeDb("publish-plan-catalog-v13 publishV13() (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Every PlanVersion row a test below creates for itself (never a pre-existing one) — deleted
  // here as a final safety net. Each test that uses `withNoPublishedVersion` also demotes its
  // own new row to SUPERSEDED before returning, so at most one row is ever PUBLISHED at a time
  // by the time any other test (or the restore in `withNoPublishedVersion`) runs.
  const createdVersionIds: string[] = [];

  afterAll(async () => {
    for (const id of createdVersionIds) {
      await prisma.addonSku.deleteMany({ where: { planVersionId: id } });
      await prisma.planDefinition.deleteMany({ where: { planVersionId: id } });
      await prisma.planVersion.delete({ where: { id } }).catch(() => {
        // Already deleted by the test itself — fine.
      });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  /**
   * Demotes whatever PlanVersion row(s) are currently PUBLISHED to SUPERSEDED, runs `fn`, then
   * restores those exact rows back to PUBLISHED (original publishedAt/effectiveAt included) —
   * regardless of what `fn` itself did to the catalog in between. `fn` is responsible for
   * cleaning up (or demoting) anything IT creates before returning, so exactly the original
   * row(s) end up PUBLISHED again once this resolves.
   */
  async function withNoPublishedVersion<T>(fn: () => Promise<T>): Promise<T> {
    const toRestore = await prisma.planVersion.findMany({
      where: { status: "PUBLISHED" },
      select: { id: true, publishedAt: true, effectiveAt: true },
    });
    if (toRestore.length) {
      await prisma.planVersion.updateMany({
        where: { id: { in: toRestore.map((v) => v.id) } },
        data: { status: "SUPERSEDED" },
      });
    }
    try {
      return await fn();
    } finally {
      for (const v of toRestore) {
        await prisma.planVersion.update({
          where: { id: v.id },
          data: { status: "PUBLISHED", publishedAt: v.publishedAt, effectiveAt: v.effectiveAt },
        });
      }
    }
  }

  it("is idempotent — a second call always reports a noop against the same version", async () => {
    // If nothing has published v13 in this environment yet, `first` does it for real (what
    // `npm run local:seed` now does via db:publish:catalog:v13) — left in place.
    const first = await publishV13(prisma);

    const second = await publishV13(prisma);
    expect(second.action).toBe("noop");
    expect(second.version).toBe(first.version);

    const published = await prisma.planVersion.findFirstOrThrow({
      where: { status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: WITH_CATALOG,
    });
    expect(published.version).toBe(first.version);
    expect(published.definitions.find((d) => d.planKey === "LITE")?.featureFlags).toContain(
      "flag.returns",
    );
  });

  it("publishes v13 WITHOUT re-pinning any tenant: every Tenant.planVersionId is unchanged, the prior version stays SUPERSEDED", async () => {
    const pinnedBefore = await prisma.tenant.findMany({
      select: { id: true, planVersionId: true },
      orderBy: { id: "asc" },
    });
    const newVersionId = await withNoPublishedVersion(async () => {
      const priorPublished = await prisma.planVersion.findFirst({
        where: { status: "SUPERSEDED" },
        orderBy: { version: "desc" },
      });
      const result = await publishV13(prisma);
      expect(result.action).toBe("published");
      const row = await prisma.planVersion.findUniqueOrThrow({
        where: { version: result.version },
      });
      expect(row.status).toBe("PUBLISHED");
      if (priorPublished) {
        const prior = await prisma.planVersion.findUniqueOrThrow({
          where: { id: priorPublished.id },
        });
        expect(prior.status).toBe("SUPERSEDED");
      }
      await prisma.planVersion.update({ where: { id: row.id }, data: { status: "SUPERSEDED" } });
      return row.id;
    });
    createdVersionIds.push(newVersionId);
    const pinnedAfter = await prisma.tenant.findMany({
      select: { id: true, planVersionId: true },
      orderBy: { id: "asc" },
    });
    expect(pinnedAfter).toEqual(pinnedBefore);
  });

  it("creates and publishes a fresh v13 DRAFT — LITE carries flag.returns, every other row as defined", async () => {
    const newVersionId = await withNoPublishedVersion(async () => {
      const result = await publishV13(prisma);
      expect(result.action).toBe("published");

      const row: CatalogVersion = await prisma.planVersion.findUniqueOrThrow({
        where: { version: result.version },
        include: WITH_CATALOG,
      });
      expect(row.status).toBe("PUBLISHED");
      expect(row.definitions.map((d) => d.planKey)).toEqual(V13_DEFINITIONS.map((d) => d.planKey));
      for (const d of V13_DEFINITIONS) {
        expect(row.definitions.find((r) => r.planKey === d.planKey)?.featureFlags).toEqual(
          d.featureFlags,
        );
      }
      expect(row.definitions.find((d) => d.planKey === "LITE")!.featureFlags).toEqual([
        "flag.returns",
      ]);
      expect(row.addonSkus.map((s) => s.sku).sort()).toEqual(
        V13_ADDON_SEEDS.map((s) => s.sku).sort(),
      );
      expect(row.notes).toContain("v13: LITE gains flag.returns");

      await prisma.planVersion.update({ where: { id: row.id }, data: { status: "SUPERSEDED" } });
      return row.id;
    });
    createdVersionIds.push(newVersionId);
  });

  it("resumes a matching leftover DRAFT from an interrupted prior run instead of creating a second one", async () => {
    const newVersionId = await withNoPublishedVersion(async () => {
      const countBefore = await prisma.planVersion.count();
      const { notes, definitionRows, addonSkuRows } = buildV13Rows(null);
      const maxVer = await prisma.planVersion.aggregate({ _max: { version: true } });
      const leftoverDraft = await prisma.planVersion.create({
        data: {
          version: (maxVer._max.version ?? 0) + 1,
          status: "DRAFT",
          notes,
          definitions: { create: definitionRows },
          addonSkus: { create: addonSkuRows },
        },
      });
      const countAfterDraft = await prisma.planVersion.count();
      expect(countAfterDraft).toBe(countBefore + 1);

      const result = await publishV13(prisma);
      expect(result.action).toBe("published");
      expect(result.version).toBe(leftoverDraft.version);

      // No second PlanVersion row was created — publishV13 resumed the leftover DRAFT in place.
      const countAfterPublish = await prisma.planVersion.count();
      expect(countAfterPublish).toBe(countAfterDraft);

      const row = await prisma.planVersion.findUniqueOrThrow({ where: { id: leftoverDraft.id } });
      expect(row.status).toBe("PUBLISHED");

      await prisma.planVersion.update({
        where: { id: leftoverDraft.id },
        data: { status: "SUPERSEDED" },
      });
      return leftoverDraft.id;
    });
    createdVersionIds.push(newVersionId);
  });

  it("refuses a mismatched pre-existing DRAFT rather than overwriting it", async () => {
    await withNoPublishedVersion(async () => {
      const maxVer = await prisma.planVersion.aggregate({ _max: { version: true } });
      const mismatchedDraft = await prisma.planVersion.create({
        data: {
          version: (maxVer._max.version ?? 0) + 1,
          status: "DRAFT",
          notes: "qa fixture — publish-plan-catalog-v13.db.spec.ts (intentionally mismatched)",
          definitions: {
            create: [
              {
                planKey: "STARTER",
                name: "Starter",
                monthlyPrice: 99,
                isCustom: false,
                featureFlags: [],
              },
            ],
          },
        },
      });
      try {
        await expect(publishV13(prisma)).rejects.toThrow(
          /doesn't match the v13 catalog this script publishes/,
        );
        // Never published (or otherwise mutated) the mismatched DRAFT we don't own.
        const stillDraft = await prisma.planVersion.findUniqueOrThrow({
          where: { id: mismatchedDraft.id },
        });
        expect(stillDraft.status).toBe("DRAFT");
      } finally {
        await prisma.addonSku.deleteMany({ where: { planVersionId: mismatchedDraft.id } });
        await prisma.planDefinition.deleteMany({ where: { planVersionId: mismatchedDraft.id } });
        await prisma.planVersion.delete({ where: { id: mismatchedDraft.id } });
      }
    });
  });
});
