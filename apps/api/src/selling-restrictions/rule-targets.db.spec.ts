/**
 * Row 509 (SA design gate 2026-10-14, option A): a selling restriction rule covers many products and/or labels
 * through `SellingRestrictionTarget`, and the ONE engine (`evaluate` + `restrictedProductIdsFor`) reads them.
 * Pins, on REAL Postgres:
 *  - a rule matches through every ACTIVE target, product or label (evaluate BLOCK + buyer hide);
 *  - a target removed at t stops matching from t, and a check AT an earlier time still blocks (history);
 *  - a rule WITH target rows ignores its legacy productId (a removed first target no longer matches);
 *  - a rule with legacy columns and ZERO target rows still matches (SA condition 1, deploy skew, fail closed);
 *  - a family target hides a variant added later (lineage);
 *  - the migration's backfill gives every legacy rule exactly one equal target, is idempotent, and leaves every
 *    evaluation unchanged (SA condition 3 / parity pin 5).
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). The tenant is a throwaway `qa-r509-<run>` slug
 * approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buyerVisibilityFor, buyerVisibleProductWhere } from "../buyer/buyer-product-visibility";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SellingRestrictionsService } from "./selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const FROM = new Date("2026-01-01T00:00:00Z");

/** The backfill statement exactly as the migration ships it (the INSERT … SELECT block). */
function backfillSql(): string {
  const sql = readFileSync(
    join(
      __dirname,
      "../../prisma/migrations/20261014120000_selling_restriction_targets/migration.sql",
    ),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "SellingRestrictionTarget"');
  if (start < 0) throw new Error("backfill INSERT not found in the migration");
  const end = sql.indexOf(";", start); // the statement ends at its own `;` (COMMIT follows)
  if (end < 0) throw new Error("backfill INSERT has no terminating ;");
  return sql.slice(start, end + 1);
}

describeDb("row 509: rule targets in the one engine — real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: SellingRestrictionsService;
  let tenantId: string;
  let customerId: string;
  const p: Record<string, string> = {};
  const c: Record<string, string> = {};

  const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
  const hidden = () =>
    as(async () => {
      const where = buyerVisibleProductWhere(
        await buyerVisibilityFor(service, tenantId, customerId),
      );
      const visible = new Set(
        (await prisma.forTenant().product.findMany({ where, select: { id: true } })).map(
          (r: { id: string }) => r.id,
        ),
      );
      return (key: string) => !visible.has(p[key]);
    });
  const hiddenAt = (at: Date) =>
    as(async () => {
      const ids = await service.restrictedProductIdsFor(tenantId, customerId, at);
      return (key: string) => ids.has(p[key]);
    });
  const outcome = (key: string, at?: Date) =>
    as(
      async () =>
        (
          await service.evaluate(tenantId, customerId, [{ productId: p[key] }], {
            channel: "BUYER_PORTAL",
            ...(at ? { at } : {}),
          })
        ).outcome,
    );
  const mkProduct = async (key: string, extra: Record<string, unknown> = {}) => {
    p[key] = (
      await prisma.product.create({
        data: {
          tenantId,
          name: `R509 ${key} ${RUN}`,
          unit: "each",
          pricePerUnit: 10,
          ...extra,
        } as never,
      })
    ).id;
  };
  /** A FEDERAL portal rule; `legacy` is what the old column holds (the XOR CHECK needs exactly one). */
  const mkRule = async (
    legacy: { productId?: string; categoryId?: string },
    over: Record<string, unknown> = {},
  ) =>
    (
      await prisma.sellingRestriction.create({
        data: {
          tenantId,
          ...legacy,
          jurisdiction: "FEDERAL",
          states: [],
          surface: "BUYER_PORTAL",
          reason: `R509 ${RUN}`,
          effectiveFrom: FROM,
          ...over,
        } as never,
      })
    ).id;
  const mkTarget = (
    ruleId: string,
    t: { productId?: string; categoryId?: string; addedAt?: Date; removedAt?: Date },
  ) =>
    prisma.sellingRestrictionTarget.create({
      data: { tenantId, ruleId, addedAt: FROM, ...t },
    });

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));

    const slug = assertTestTenant(`qa-r509-${RUN}`, "rule-targets.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `R509 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `r509-${RUN}@example.invalid`,
        username: `r509-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "R509 Buyer", contactName: "R509", tenantId },
      })
    ).id;
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId,
        line1: "1 Test St",
        city: "Testville",
        state: "TX",
        stateCode: "TX",
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    c.vape = (await prisma.productCategory.create({ data: { tenantId, name: `Vape ${RUN}` } })).id;
    for (const k of ["a", "b", "d", "e", "free", "lab", "legacyOnly", "legacyCat"])
      await mkProduct(k);
    await mkProduct("fam", { kind: "FAMILY" });
    await mkProduct("v1", { kind: "VARIANT", parentProductId: p.fam });
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: p.lab, categoryId: c.vape, mode: "INCLUDE" },
    });
    c.legacy = (
      await prisma.productCategory.create({ data: { tenantId, name: `Legacy ${RUN}` } })
    ).id;
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: p.legacyCat, categoryId: c.legacy, mode: "INCLUDE" },
    });
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.sellingRestrictionTarget.deleteMany({ where: { tenantId } });
      await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
      await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
      await prisma.customerAddress.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.productCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }, 120_000);

  afterEach(async () => {
    await prisma.sellingRestrictionTarget.deleteMany({ where: { tenantId } });
    await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
  });

  it("a multi-target rule matches EVERY active target — products and a label — and nothing else", async () => {
    const rule = await mkRule({ productId: p.a }); // legacy column mirrors the FIRST target
    await mkTarget(rule, { productId: p.a });
    await mkTarget(rule, { productId: p.b });
    await mkTarget(rule, { categoryId: c.vape });
    const isHidden = await hidden();
    expect(["a", "b", "lab"].map(isHidden)).toEqual([true, true, true]);
    expect(isHidden("free")).toBe(false);
    expect(await outcome("b")).toBe("BLOCK");
    expect(await outcome("lab")).toBe("BLOCK");
    expect(await outcome("free")).toBe("ALLOW");
  });

  it("a target removed at t stops matching from t; a check at an earlier time still blocks", async () => {
    const removedAt = new Date(Date.now() - 60_000);
    const rule = await mkRule({ productId: p.a });
    await mkTarget(rule, { productId: p.a });
    await mkTarget(rule, { productId: p.d, removedAt });
    expect(await outcome("d")).toBe("ALLOW");
    expect((await hidden())("d")).toBe(false);
    const before = new Date(removedAt.getTime() - 60_000);
    expect(await outcome("d", before)).toBe("BLOCK");
    expect((await hiddenAt(before))("d")).toBe(true);
  });

  it("a rule WITH target rows ignores its legacy column: a removed first target no longer matches", async () => {
    const rule = await mkRule({ productId: p.e });
    await mkTarget(rule, { productId: p.e, removedAt: new Date(Date.now() - 60_000) });
    await mkTarget(rule, { productId: p.b });
    expect(await outcome("e")).toBe("ALLOW");
    expect((await hidden())("e")).toBe(false);
    expect(await outcome("b")).toBe("BLOCK");
  });

  it("SA condition 1: a rule with legacy columns and ZERO target rows still matches (deploy skew, fail closed)", async () => {
    await mkRule({ productId: p.legacyOnly });
    await mkRule({ categoryId: c.legacy });
    const isHidden = await hidden();
    expect(isHidden("legacyOnly")).toBe(true);
    expect(isHidden("legacyCat")).toBe(true);
    expect(await outcome("legacyOnly")).toBe("BLOCK");
    expect(await outcome("legacyCat")).toBe("BLOCK");
  });

  it("a family target hides a variant added later (lineage)", async () => {
    const rule = await mkRule({ productId: p.fam });
    await mkTarget(rule, { productId: p.fam });
    await mkProduct("v2late", { kind: "VARIANT", parentProductId: p.fam });
    const isHidden = await hidden();
    expect(isHidden("v1")).toBe(true);
    expect(isHidden("v2late")).toBe(true);
    expect(await outcome("v2late")).toBe("BLOCK");
  });

  it("SA condition 3 / parity 5: the migration's backfill gives every legacy rule one equal target, idempotently, and changes no decision", async () => {
    const createdBy = { createdById: `u-${RUN}`, createdByName: "R509 Admin" };
    const r1 = await mkRule({ productId: p.legacyOnly }, createdBy);
    // a STATE / surface ALL legal ban (the customer is in TX)
    const r2 = await mkRule(
      { categoryId: c.legacy },
      { jurisdiction: "STATE", states: ["TX"], surface: "ALL", ...createdBy },
    );
    const r3 = await mkRule({ productId: p.fam }, createdBy);
    // a LIFTED rule is history too: it gets its target, and still decides nothing
    const r4 = await mkRule(
      { productId: p.a },
      { liftedAt: new Date(Date.now() - 60_000), liftReason: "done", ...createdBy },
    );
    const keys = ["legacyOnly", "legacyCat", "v1", "free", "a"];
    const before = await Promise.all(keys.map((k) => outcome(k)));
    const hiddenBefore = await hidden();

    await prisma.$executeRawUnsafe(backfillSql());
    const rows = await prisma.sellingRestrictionTarget.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(4);
    const byRule = new Map(rows.map((r) => [r.ruleId, r]));
    for (const r of rows) {
      expect(r.addedAt.toISOString()).toBe(FROM.toISOString()); // LEAST(createdAt, effectiveFrom)
      expect(r.addedById).toBe(`u-${RUN}`);
      expect(r.addedByName).toBe("R509 Admin");
    }
    expect(byRule.get(r4)).toMatchObject({ productId: p.a, removedAt: null });
    expect(byRule.get(r1)).toMatchObject({
      productId: p.legacyOnly,
      categoryId: null,
      removedAt: null,
    });
    expect(byRule.get(r2)).toMatchObject({
      productId: null,
      categoryId: c.legacy,
      removedAt: null,
    });
    expect(byRule.get(r3)).toMatchObject({ productId: p.fam, categoryId: null, removedAt: null });

    await prisma.$executeRawUnsafe(backfillSql()); // re-run: idempotent
    expect(await prisma.sellingRestrictionTarget.count({ where: { tenantId } })).toBe(4);

    expect(await Promise.all(keys.map((k) => outcome(k)))).toEqual(before);
    const hiddenAfter = await hidden();
    expect(keys.map(hiddenAfter)).toEqual(keys.map(hiddenBefore));
  });

  it("SA must 2: a BACKDATED rule's backfilled target starts at effectiveFrom, never at createdAt", async () => {
    // effectiveFrom (FROM, Jan 1) is long before createdAt (now): the rule has been in force since Jan 1
    const r = await mkRule({ productId: p.b });
    await prisma.$executeRawUnsafe(backfillSql());
    const t = await prisma.sellingRestrictionTarget.findFirstOrThrow({ where: { ruleId: r } });
    expect(t.addedAt.toISOString()).toBe(FROM.toISOString());
    const between = new Date(FROM.getTime() + 86_400_000); // after effectiveFrom, before createdAt
    expect(await outcome("b", between)).toBe("BLOCK");
    expect((await hiddenAt(between))("b")).toBe(true);
  });
});
