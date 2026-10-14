/**
 * Lane R step 4a — DB lane for the label WRITE side (the real-Postgres items of the #990 review).
 * What a mocked prisma cannot prove: the advisory lock + `SET LOCAL lock_timeout` run through the
 * REAL tenant-wrapped `tenantTransaction` proxy; two concurrent transactions on one tenant x
 * category really serialize (no orphan opt-out survives); a held lock surfaces as a fast 409, not a
 * 5 s P2028; the nested `categoryLabels: { where }` select filters in SQL; another tenant's rows are
 * unreachable and untouched. (A P2002 on the (product, category) unique is unreachable through the
 * service now — the lock serializes first writers — so that mapping stays with the unit spec.)
 *
 * Run via `npm run local:test:db` against the compose Postgres. Every tenant is a throwaway
 * `qa-lbl-<run>-*` slug approved by `assertTestTenant`, and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { ProductLabelsAdminService } from "./product-labels-admin.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const user = { sub: "u-db-spec", username: "db-spec" } as JwtPayload;

describeDb("label write side against real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: ProductLabelsAdminService;
  let effective: ProductLabelsService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-lbl-${run}-a`, "product-labels-admin.db.spec.ts");
  const slugB = assertTestTenant(`qa-lbl-${run}-b`, "product-labels-admin.db.spec.ts");
  let A: { tenantId: string; cat: string; other: string; gp: string; p: string; v: string };
  let B: { tenantId: string; cat: string; prod: string };
  let vGp: string; // set per test where needed

  const asA = <T>(fn: () => Promise<T>) => ctx.run(A.tenantId, fn);
  const labelsOf = (productId: string) =>
    raw.productCategoryLabel.findMany({ where: { productId } });

  async function seedProduct(tenantId: string, name: string, parentProductId?: string) {
    const p = await raw.product.create({
      data: {
        name,
        unit: "EACH",
        pricePerUnit: "1.00",
        tenantId,
        parentProductId: parentProductId ?? null,
      },
    });
    return p.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    effective = new ProductLabelsService(prisma);
    service = new ProductLabelsAdminService(prisma, new AuditService(prisma), effective);

    const ta = await raw.tenant.create({ data: { slug: slugA, name: `Label spec ${slugA}` } });
    const tb = await raw.tenant.create({ data: { slug: slugB, name: `Label spec ${slugB}` } });
    const cat = await raw.productCategory.create({ data: { tenantId: ta.id, name: "Alcohol" } });
    const other = await raw.productCategory.create({ data: { tenantId: ta.id, name: "THC" } });
    const gp = await seedProduct(ta.id, "GP");
    const p = await seedProduct(ta.id, "P", gp);
    const v = await seedProduct(ta.id, "V", p);
    A = { tenantId: ta.id, cat: cat.id, other: other.id, gp, p, v };
    const bcat = await raw.productCategory.create({ data: { tenantId: tb.id, name: "Alcohol" } });
    const bprod = await seedProduct(tb.id, "B-prod");
    B = { tenantId: tb.id, cat: bcat.id, prod: bprod };
    vGp = gp;
  }, 120_000);

  afterAll(async () => {
    for (const t of [A?.tenantId, B?.tenantId].filter(Boolean) as string[]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
      await raw.productCategoryLabel.deleteMany({ where: { tenantId: t } });
      await raw.product.deleteMany({ where: { tenantId: t, parentProductId: { not: null } } });
      await raw.product.deleteMany({ where: { tenantId: t } });
      await raw.productCategory.deleteMany({ where: { tenantId: t } });
      await raw.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  beforeEach(async () => {
    await raw.productCategoryLabel.deleteMany({
      where: { tenantId: { in: [A.tenantId, B.tenantId] } },
    });
  });

  it("the lock + SET LOCAL lock_timeout run through the real wrapped tx, and the timeout is restored to 0", async () => {
    await asA(() => service.setLabel(A.gp, A.cat, { mode: "INCLUDE" }, user));
    expect(await labelsOf(A.gp)).toHaveLength(1);
    const shown = await asA(() =>
      prisma.tenantTransaction(async (tx: any) => {
        await (service as any).lockCategory(tx, A.tenantId, A.cat);
        const rows = await tx.$queryRawUnsafe("SHOW lock_timeout");
        return rows[0].lock_timeout as string;
      }),
    );
    expect(shown).toBe("0");
  }, 30_000);

  it("concurrent setLabel(EXCLUDE) vs removeLabel(parent INCLUDE) serialize: NO orphan opt-out survives, and re-adding the label leaves the variant blocked", async () => {
    for (let i = 0; i < 6; i++) {
      await raw.productCategoryLabel.deleteMany({ where: { tenantId: A.tenantId } });
      await asA(() => service.setLabel(A.gp, A.cat, { mode: "INCLUDE" }, user));
      const results = await Promise.allSettled([
        asA(() => service.setLabel(A.v, A.cat, { mode: "EXCLUDE", reason: "alcohol-free" }, user)),
        asA(() => service.removeLabel(A.gp, A.cat, user)),
      ]);
      // Whichever wins, the invariant holds: the INCLUDE is gone, so no opt-out may remain.
      const all = await raw.productCategoryLabel.findMany({
        where: { tenantId: A.tenantId, categoryId: A.cat },
      });
      expect(all.filter((l) => l.mode === "EXCLUDE")).toHaveLength(0);
      expect(results[1].status).toBe("fulfilled"); // the removal always succeeds
      // "I removed that by mistake": re-adding must NOT leave V silently exempt.
      await asA(() => service.setLabel(A.gp, A.cat, { mode: "INCLUDE" }, user));
      const eff = await asA(() => effective.effectiveLabels(A.tenantId, [A.v]));
      expect([...eff.get(A.v)!.effectiveCategoryIds]).toEqual([A.cat]);
    }
  }, 60_000);

  it("a held lock surfaces as a fast 409 (~2 s), not a 5 s interactive-transaction timeout", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        "product-labels",
        `${A.tenantId}:${A.cat}`,
      ]);
      const t0 = Date.now();
      await expect(
        asA(() => service.setLabel(A.gp, A.cat, { mode: "INCLUDE" }, user)),
      ).rejects.toBeInstanceOf(ConflictException);
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(1500);
      expect(waited).toBeLessThan(4500); // well inside Prisma's 5 s budget
      expect(await labelsOf(A.gp)).toHaveLength(0); // nothing was written
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);

  it("the nested categoryLabels select filters by category in SQL through the tenant proxy", async () => {
    await raw.productCategoryLabel.createMany({
      data: [
        { tenantId: A.tenantId, productId: A.gp, categoryId: A.cat, mode: "INCLUDE" },
        { tenantId: A.tenantId, productId: A.gp, categoryId: A.other, mode: "INCLUDE" },
      ],
    });
    const row = await asA(() =>
      prisma.forTenant().product.findFirst({
        where: { id: vGp },
        select: {
          categoryLabels: {
            where: { categoryId: A.cat },
            select: { categoryId: true, mode: true },
          },
        },
      }),
    );
    expect(row!.categoryLabels).toEqual([{ categoryId: A.cat, mode: "INCLUDE" }]);
  });

  it("another tenant's product and category are unreachable, and its rows stay untouched", async () => {
    await raw.productCategoryLabel.create({
      data: { tenantId: B.tenantId, productId: B.prod, categoryId: B.cat, mode: "INCLUDE" },
    });
    await expect(
      asA(() => service.setLabel(B.prod, A.cat, { mode: "INCLUDE" }, user)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asA(() => service.setLabel(A.gp, B.cat, { mode: "INCLUDE" }, user)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(asA(() => service.removeLabel(B.prod, B.cat, user))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await labelsOf(B.prod)).toHaveLength(1);
  });
  it("owner ruling 2026-10-14: an operator is refused only on a label an ACTIVE federal rule covers (real SQL)", async () => {
    const operator = { sub: "op", username: "op", role: "OPERATOR" } as never;
    const FROM = new Date("2026-01-01T00:00:00Z");
    const mkRule = (data: Record<string, unknown>) =>
      raw.sellingRestriction.create({
        data: {
          tenantId: A.tenantId,
          states: [],
          surface: "ALL",
          reason: `lbl ${run}`,
          effectiveFrom: FROM,
          ...data,
        } as never,
      });
    const setGp = () => asA(() => service.setLabel(A.gp, A.cat, { mode: "INCLUDE" }, operator));
    const clear = async () => {
      await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: A.tenantId } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: A.tenantId } });
      await raw.productCategoryLabel.deleteMany({ where: { tenantId: A.tenantId } });
    };
    try {
      // a STATE rule on the label: allowed
      await mkRule({ categoryId: A.cat, jurisdiction: "STATE", states: ["TX"] });
      await setGp();
      expect(await labelsOf(A.gp)).toHaveLength(1);
      await clear();

      // a legacy FEDERAL rule on the label: 403, nothing written
      await mkRule({ categoryId: A.cat, jurisdiction: "FEDERAL" });
      await expect(setGp()).rejects.toThrow(
        "Only an account admin can change (or lift) a federal rule.",
      );
      expect(await labelsOf(A.gp)).toHaveLength(0);
      await clear();

      // a FEDERAL rule covering the label by an active TARGET row (legacy column elsewhere): 403
      const r = await mkRule({ categoryId: A.other, jurisdiction: "FEDERAL" });
      await raw.sellingRestrictionTarget.create({
        data: { tenantId: A.tenantId, ruleId: r.id, categoryId: A.cat, addedAt: FROM },
      });
      await expect(setGp()).rejects.toThrow("federal rule");
      // the same rule once that target row is removed: allowed (its other target does not cover the label)
      await raw.sellingRestrictionTarget.updateMany({
        where: { ruleId: r.id, categoryId: A.cat },
        data: { removedAt: FROM },
      });
      await raw.sellingRestrictionTarget.create({
        data: { tenantId: A.tenantId, ruleId: r.id, categoryId: A.other, addedAt: FROM },
      });
      await setGp();
      expect(await labelsOf(A.gp)).toHaveLength(1);
      await clear();

      // a LIFTED federal rule no longer protects the label
      await mkRule({ categoryId: A.cat, jurisdiction: "FEDERAL", liftedAt: FROM });
      await setGp();
      expect(await labelsOf(A.gp)).toHaveLength(1);
    } finally {
      await clear();
    }
  });
});
