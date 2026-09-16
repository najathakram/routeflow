/**
 * DB-lane spec for prisma/publish-plan-catalog-v12.ts's `publishV12(prisma)` (WP4, lite-L2 —
 * R1.5/R1.6/R1.9/R3b.6/R7.2/R7.4) — proves the idempotency/DRAFT-resume/DRAFT-refuse
 * mechanics against a REAL Postgres. The pure data/row-building logic (V12_DEFINITIONS,
 * V12_ADDON_SEEDS, buildV12Rows) is already covered without a DB by plan-catalog-v12.spec.ts;
 * this file only exercises what actually needs a live database — the PlanVersion/
 * PlanDefinition/AddonSku writes and the PUBLISHED/DRAFT lifecycle transitions.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * UNTESTED BY EXECUTION as of this writing — no database is available in the environment
 * that authored this file. It has been verified to typecheck (`tsc --noEmit`) but has NEVER
 * been run against a real Postgres. Run it via `npm run local:test:db` once the compose stack
 * is available, before relying on it as a passing gate.
 *
 * PlanVersion/PlanDefinition/AddonSku are GLOBAL reference data (not tenant-scoped) with a
 * single logical "currently PUBLISHED" row and at most one "currently DRAFT" row —
 * `publishV12` reads and writes exactly that global singleton state, the same way the real
 * `npm run db:publish:catalog:v12` invocation would. This file's tests fall into two shapes:
 *
 *   1. "idempotent — a second call is always a noop" runs directly against whatever the
 *      compose DB's real catalog state is (it may itself perform the real, permanent v12
 *      publish if this is the first thing to touch that catalog in this environment — that is
 *      the desired end state, identical to what `npm run local:seed` already does via
 *      `db:publish:catalog:v12`). This test makes no destructive change and needs no cleanup.
 *
 *   2. The create/resume/refuse branch tests need a "no PUBLISHED version has LITE yet"
 *      precondition, which by then may not hold (test 1, or a prior `local:seed`, may already
 *      have published v12 for real). `withNoPublishedVersion()` below temporarily demotes
 *      whatever is currently PUBLISHED to SUPERSEDED (a real, valid status transition — the
 *      same one `publishV12` itself performs on every run) for the narrow duration of one
 *      test, then restores it to PUBLISHED in a `finally` — the same scoped-mutation pattern
 *      `backfill-subscription-reconciliation.db.spec.ts` uses for its own fixture PlanVersion
 *      rows, applied here to the real one because this script's whole purpose IS managing that
 *      singleton. Every row a test creates is deleted (or, for the real row, restored) before
 *      the test returns, and `afterAll` deletes every row `createdVersionIds` ever collected as
 *      a final safety net.
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { publishV12 } from "../../prisma/publish-plan-catalog-v12";
import {
  NEW_PLAN_FLAGS,
  V12_ADDON_SEEDS,
  buildV12Rows,
} from "../../prisma/plan-catalog-v12.definitions";

const WITH_CATALOG = {
  definitions: { orderBy: { sortOrder: "asc" } },
  addonSkus: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.PlanVersionInclude;
type CatalogVersion = Prisma.PlanVersionGetPayload<{ include: typeof WITH_CATALOG }>;

describeDb("publish-plan-catalog-v12 publishV12() (db)", () => {
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
    // If this is the first thing in this environment to touch the catalog, `first` really
    // publishes v12 for real (the same permanent effect `npm run local:seed` produces via
    // `db:publish:catalog:v12`) — intentionally left in place, not a fixture to clean up.
    const first = await publishV12(prisma);

    const second = await publishV12(prisma);
    expect(second.action).toBe("noop");
    expect(second.version).toBe(first.version);

    const published = await prisma.planVersion.findFirstOrThrow({
      where: { status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: WITH_CATALOG,
    });
    expect(published.version).toBe(first.version);
    expect(published.definitions.some((d) => d.planKey === "LITE")).toBe(true);
  });

  it("creates and publishes a fresh v12 DRAFT — LITE first, existing plans gain the 5 new flags, addon SKUs unchanged from v11", async () => {
    const newVersionId = await withNoPublishedVersion(async () => {
      const result = await publishV12(prisma);
      expect(result.action).toBe("published");

      const row: CatalogVersion = await prisma.planVersion.findUniqueOrThrow({
        where: { version: result.version },
        include: WITH_CATALOG,
      });
      expect(row.status).toBe("PUBLISHED");

      expect(row.definitions.map((d) => d.planKey).sort()).toEqual(
        ["ENTERPRISE", "GROWTH", "LITE", "SCALE", "STARTER"].sort(),
      );

      const lite = row.definitions.find((d) => d.planKey === "LITE");
      expect(lite).toBeDefined();
      expect(lite!.sortOrder).toBe(0);
      expect(Number(lite!.monthlyPrice)).toBe(99);
      expect(Number(lite!.annualPrice)).toBe(990);
      expect(lite!.isCustom).toBe(false);
      expect(lite!.customersIncluded).toBe(100);
      expect(lite!.seatsIncluded).toBe(3);
      expect(lite!.routesConcurrent).toBe(0);
      expect(lite!.scansIncluded).toBe(0);
      expect(lite!.msgsIncluded).toBe(0);
      expect(lite!.featureFlags).toEqual([]);

      // Every non-LITE definition gained all 5 NEW_PLAN_FLAGS.
      for (const d of row.definitions) {
        if (d.planKey === "LITE") continue;
        for (const flag of NEW_PLAN_FLAGS) {
          expect(d.featureFlags).toContain(flag);
        }
      }

      // Addon SKUs are exactly V12_ADDON_SEEDS (== V11's) — nothing added, nothing retired.
      expect(row.addonSkus.map((s) => s.sku).sort()).toEqual(
        V12_ADDON_SEEDS.map((s) => s.sku).sort(),
      );
      expect(row.addonSkus).toHaveLength(V12_ADDON_SEEDS.length);

      expect(row.notes).toContain("v12: add LITE (invite-only)");

      // Move this test's own new row out of PUBLISHED before the helper restores the
      // original(s) — leaves exactly the pre-existing row PUBLISHED again afterward.
      await prisma.planVersion.update({ where: { id: row.id }, data: { status: "SUPERSEDED" } });
      return row.id;
    });
    createdVersionIds.push(newVersionId);
  });

  it("resumes a matching leftover DRAFT from an interrupted prior run instead of creating a second one", async () => {
    const newVersionId = await withNoPublishedVersion(async () => {
      const countBefore = await prisma.planVersion.count();
      const { notes, definitionRows, addonSkuRows } = buildV12Rows(null);
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

      const result = await publishV12(prisma);
      expect(result.action).toBe("published");
      expect(result.version).toBe(leftoverDraft.version);

      // No second PlanVersion row was created — publishV12 resumed the leftover DRAFT in place.
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
          notes: "qa fixture — publish-plan-catalog-v12.db.spec.ts (intentionally mismatched)",
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
        await expect(publishV12(prisma)).rejects.toThrow(
          /doesn't match the v12 catalog this script publishes/,
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
