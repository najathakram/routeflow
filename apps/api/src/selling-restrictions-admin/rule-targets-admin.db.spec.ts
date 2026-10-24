/**
 * Row 509 PR2 — the rule-targets admin API against REAL Postgres (SA option A conditions 1, 2, 5, 6; owner Q1, Q2,
 * Q5, Q6). What a mocked prisma cannot prove:
 *  - create with N mixed targets: legacy column = the FIRST target (product first), one target row per id,
 *    `addedAt` = the rule's effectiveFrom when earlier than now; bad ids write nothing;
 *  - add skips and reports ids already in; the 5,000 per-rule and 1,000 per-call caps are coded; a legacy rule with
 *    ZERO target rows has its legacy target materialised first so coverage is never dropped; remove stamps history
 *    rows and refuses the last target; a lifted rule is RULE_NOT_EDITABLE; an all-customer rule is admin-only;
 *  - add / remove / lift / lift-batch serialize on the rule row's FOR UPDATE lock (ordering proven with a held lock);
 *  - bulk creates ONE rule; holding; product chips through TARGET / PARENT / CATEGORY; the label archive guard counts
 *    rules that hold the label as a target.
 *
 * Run via `npm run local:test:db`. The tenants are throwaway `qa-r509pr2-<run>-*` slugs approved by
 * `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { HttpException } from "@nestjs/common";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, PoolClient } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { ProductCategoriesService } from "../product-categories/product-categories.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";
import { RuleTargetsService } from "./rule-targets.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "rule-targets-admin.db.spec.ts";
const operator = {
  sub: "u-r509-op",
  username: "r509-operator",
  role: UserRole.OPERATOR,
} as JwtPayload;
const admin = {
  sub: "u-r509-admin",
  username: "r509-admin",
  role: UserRole.TENANT_ADMIN,
} as JwtPayload;
const PAST = new Date("2026-01-01T00:00:00Z");

describeDb("row 509 PR2: rule targets admin API — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let rules: SellingRestrictionsAdminService;
  let targets: RuleTargetsService;
  let engine: SellingRestrictionsService;
  let categories: ProductCategoriesService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-r509pr2-${run}-a`, SPEC);
  const slugB = assertTestTenant(`qa-r509pr2-${run}-b`, SPEC);
  let tenantA: string;
  let tenantB: string;
  let customerId: string;
  const p: Record<string, string> = {};
  const c: Record<string, string> = {};
  let foreignProduct: string;
  let foreignCategory: string;
  let bulkProducts: string[] = [];

  const asA = <T>(fn: () => Promise<T>) => ctx.run(tenantA, fn);
  const asB = <T>(fn: () => Promise<T>) => ctx.run(tenantB, fn);

  async function mkProduct(
    tenantId: string,
    key: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await raw.product.create({
      data: {
        tenantId,
        name: `R509 ${key} ${run}`,
        sku: `SKU-${key}-${run}`,
        unit: "EACH",
        pricePerUnit: "1.00",
        ...extra,
      } as never,
    });
    return row.id;
  }

  /** Create through the service (the real path). */
  const create = (over: Record<string, unknown> = {}, user: JwtPayload = admin) =>
    asA(() =>
      rules.create(
        {
          // A STATE rule by default: an all-customer (FEDERAL) rule is TENANT_ADMIN-only, so the tests that
          // exercise it say so (`federal`) and the operator tests stay on a rule an operator may change.
          jurisdiction: "STATE",
          states: ["TX"],
          surface: "BUYER_PORTAL",
          reason: "R509 PR2",
          ...over,
        } as never,
        user,
      ),
    );
  const activeTargets = (ruleId: string) =>
    raw.sellingRestrictionTarget.findMany({ where: { ruleId, removedAt: null } });
  const allTargets = (ruleId: string) =>
    raw.sellingRestrictionTarget.findMany({ where: { ruleId } });
  const audits = (action: string, entityId?: string) =>
    raw.auditLog.findMany({
      where: { tenantId: tenantA, action, ...(entityId ? { entityId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  const outcome = (key: string) =>
    asA(
      async () =>
        (
          await engine.evaluate(tenantA, customerId, [{ productId: p[key] }], {
            fulfilmentKind: "DELIVERY",
            channel: "BUYER_PORTAL",
          })
        ).outcome,
    );
  /** A legacy rule: the old column only, NO target rows (written by pre-509 code). */
  const legacyRule = async (
    legacy: { productId?: string; categoryId?: string },
    over: Record<string, unknown> = {},
  ) =>
    (
      await raw.sellingRestriction.create({
        data: {
          tenantId: tenantA,
          ...legacy,
          jurisdiction: "STATE",
          states: ["TX"],
          surface: "BUYER_PORTAL",
          reason: "R509 legacy",
          effectiveFrom: PAST,
          createdById: "u-legacy",
          createdByName: "legacy-creator",
          ...over,
        } as never,
      })
    ).id;
  const fails = async (
    promise: Promise<unknown>,
    status: number,
    body: Record<string, unknown> = {},
  ): Promise<HttpException> => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(status);
    if (Object.keys(body).length > 0)
      expect((err as HttpException).getResponse()).toMatchObject(body);
    return err as HttpException;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const labels = new ProductLabelsService(prisma);
    rules = new SellingRestrictionsAdminService(prisma, labels);
    targets = new RuleTargetsService(prisma);
    engine = new SellingRestrictionsService(prisma, labels);
    categories = new ProductCategoriesService(prisma, new AuditService(prisma));

    tenantA = (await raw.tenant.create({ data: { slug: slugA, name: `R509 PR2 ${slugA}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugB, name: `R509 PR2 ${slugB}` } })).id;
    const user = await raw.user.create({
      data: {
        email: `r509pr2-${run}@example.invalid`,
        username: `r509pr2-${run}`,
        role: "CUSTOMER",
        tenantId: tenantA,
      },
    });
    customerId = (
      await raw.customer.create({
        data: {
          userId: user.id,
          businessName: "R509 Buyer",
          contactName: "R509",
          tenantId: tenantA,
        },
      })
    ).id;
    await raw.customerAddress.create({
      data: {
        tenantId: tenantA,
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
    for (const k of ["a", "b", "d", "e", "f", "g", "legacy", "legacy2", "lab"]) {
      p[k] = await mkProduct(tenantA, k);
    }
    p.fam = await mkProduct(tenantA, "fam", { kind: "FAMILY" });
    p.v1 = await mkProduct(tenantA, "v1", {
      kind: "VARIANT",
      parentProductId: p.fam,
      name: "Mango",
    });
    p.v2 = await mkProduct(tenantA, "v2", {
      kind: "VARIANT",
      parentProductId: p.fam,
      name: "Mint",
    });
    c.vape = (
      await raw.productCategory.create({ data: { tenantId: tenantA, name: `Vape ${run}` } })
    ).id;
    c.cbd = (
      await raw.productCategory.create({ data: { tenantId: tenantA, name: `CBD ${run}` } })
    ).id;
    c.old = (
      await raw.productCategory.create({
        data: { tenantId: tenantA, name: `Old ${run}`, archivedAt: new Date() },
      })
    ).id;
    await raw.productCategoryLabel.create({
      data: { tenantId: tenantA, productId: p.lab, categoryId: c.vape, mode: "INCLUDE" },
    });
    await raw.productCategoryLabel.create({
      data: { tenantId: tenantA, productId: p.v1, categoryId: c.cbd, mode: "INCLUDE" },
    });
    foreignProduct = await mkProduct(tenantB, "foreign");
    foreignCategory = (
      await raw.productCategory.create({ data: { tenantId: tenantB, name: `Foreign ${run}` } })
    ).id;
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestrictionRevision.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
      await raw.productCategoryLabel.deleteMany({ where: { tenantId: t } });
      await raw.customerAddress.deleteMany({ where: { tenantId: t } });
      await raw.customer.deleteMany({ where: { tenantId: t } });
      await raw.product.deleteMany({ where: { tenantId: t, parentProductId: { not: null } } });
      await raw.product.deleteMany({ where: { tenantId: t } });
      await raw.productCategory.deleteMany({ where: { tenantId: t } });
      await raw.user.deleteMany({ where: { tenantId: t } });
      await raw.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const t of [tenantA, tenantB]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestrictionRevision.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
    }
  });

  // ─── create ────────────────────────────────────────────────────────────────────────────────────

  describe("create with targets", () => {
    it("N mixed targets: the legacy column is the FIRST target (a product when any), one target row per id", async () => {
      const dto = await create({
        targets: { productIds: [p.b, p.a], categoryIds: [c.vape] },
        effectiveFrom: PAST.toISOString(),
      });
      const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: dto.id } });
      expect(row.productId).toBe(p.b); // product first, in request order
      expect(row.categoryId).toBeNull(); // the XOR CHECK: exactly one legacy column
      const rows = await activeTargets(dto.id);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.productId ?? r.categoryId).sort()).toEqual(
        [c.vape, p.a, p.b].sort(),
      );
      for (const r of rows) {
        expect(r.tenantId).toBe(tenantA);
        expect(r.addedAt.toISOString()).toBe(PAST.toISOString()); // effectiveFrom is earlier than now
        expect(r.addedById).toBe(admin.sub);
        expect(r.addedByName).toBe(admin.username);
      }
      expect(dto.targetSummary).toMatchObject({ products: 2, categories: 1 });
      expect(dto.targetSummary?.preview).toHaveLength(3);
      // the one engine blocks every target
      expect(await outcome("a")).toBe("BLOCK");
      expect(await outcome("b")).toBe("BLOCK");
      expect(await outcome("lab")).toBe("BLOCK");
      expect(await outcome("d")).toBe("ALLOW");
    });

    it("categories only: the legacy column is the first label; a FUTURE effectiveFrom still stamps addedAt = now", async () => {
      const future = new Date(Date.now() + 30 * 86_400_000);
      const before = Date.now();
      const dto = await create({
        targets: { categoryIds: [c.vape, c.cbd] },
        effectiveFrom: future.toISOString(),
      });
      const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: dto.id } });
      expect(row.categoryId).toBe(c.vape);
      expect(row.productId).toBeNull();
      for (const t of await activeTargets(dto.id)) {
        expect(t.addedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(t.addedAt.getTime()).toBeLessThan(future.getTime());
      }
    });

    it("the legacy single productId / categoryId still works and writes one target", async () => {
      const a = await create({ productId: p.d });
      const b = await create({ categoryId: c.cbd });
      expect(await activeTargets(a.id)).toHaveLength(1);
      expect((await activeTargets(b.id))[0]).toMatchObject({ categoryId: c.cbd, productId: null });
      expect(
        (await raw.sellingRestriction.findUniqueOrThrow({ where: { id: a.id } })).productId,
      ).toBe(p.d);
    });

    it("audits selling_restriction.created with counts and target ids (no names)", async () => {
      const dto = await create({ targets: { productIds: [p.a, p.b], categoryIds: [c.vape] } });
      const [row] = await audits("selling_restriction.created", dto.id);
      const meta = row.meta as Record<string, unknown>;
      expect(meta).toMatchObject({
        productCount: 2,
        categoryCount: 1,
        targets: { productIds: [p.a, p.b], categoryIds: [c.vape] },
      });
      expect(JSON.stringify(meta)).not.toContain("R509 a");
      expect(JSON.stringify(meta)).not.toContain("Vape");
    });

    it("an unknown, cross-tenant or archived id is RULE_TARGETS_NOT_FOUND and NOTHING is written", async () => {
      const err = await fails(
        create({
          targets: { productIds: [p.a, foreignProduct], categoryIds: [foreignCategory, c.old] },
        }),
        409,
        { code: "RULE_TARGETS_NOT_FOUND" },
      );
      expect((err.getResponse() as { notFoundIds: string[] }).notFoundIds.sort()).toEqual(
        [foreignProduct, foreignCategory, c.old].sort(),
      );
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(0);
      expect(await raw.sellingRestrictionTarget.count({ where: { tenantId: tenantA } })).toBe(0);
      expect(await audits("selling_restriction.created")).toHaveLength(0);
    });

    it("more than 1,000 ids in one call is RULE_TARGET_LIMIT (field request), before anything is read", async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `x${i}`);
      await fails(create({ targets: { productIds: ids } }), 400, {
        code: "RULE_TARGET_LIMIT",
        field: "request",
        max: 1000,
      });
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(0);
    });

    it("an all-customer (FEDERAL) rule is admin-only (403, nothing written); a STATE rule is operator-ok", async () => {
      await fails(
        create({ jurisdiction: "FEDERAL", states: [], targets: { productIds: [p.a] } }, operator),
        403,
      );
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(0);
      const ok = await create(
        { jurisdiction: "STATE", states: ["TX"], targets: { productIds: [p.a] } },
        operator,
      );
      expect(ok.id).toBeTruthy();
    });

    it("exactly one of the legacy field and `targets` (and at least one id)", async () => {
      await fails(create({ productId: p.a, targets: { productIds: [p.b] } }), 400);
      await fails(create({ targets: { productIds: [], categoryIds: [] } }), 400);
      await fails(create({}), 400);
    });
  });

  // ─── add ───────────────────────────────────────────────────────────────────────────────────────

  describe("POST :id/targets", () => {
    it("adds, skips ids already in and reports them, audits once with ids only", async () => {
      const rule = await create({ targets: { productIds: [p.a] } });
      const res = await asA(() =>
        targets.addTargets(
          rule.id,
          { productIds: [p.a, p.b, p.b], categoryIds: [c.vape] },
          operator,
        ),
      );
      expect(res.added).toBe(2);
      expect(res.skippedIds).toEqual([p.a]);
      expect(res.activeTargets).toBe(3);
      expect(res.addedTargetIds).toHaveLength(2);
      const rows = await activeTargets(rule.id);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(res.addedTargetIds));
      const [a] = await audits("selling_restriction.targets_added", rule.id);
      expect(a.meta).toMatchObject({
        ruleId: rule.id,
        count: 2,
        productIds: [p.b],
        categoryIds: [c.vape],
      });
      // calling again adds nothing and says so
      const again = await asA(() => targets.addTargets(rule.id, { productIds: [p.b] }, operator));
      expect(again).toMatchObject({ added: 0, skippedIds: [p.b], activeTargets: 3 });
      expect(await outcome("b")).toBe("BLOCK");
    });

    it("over 5,000 active targets is RULE_TARGET_LIMIT (field rule), nothing written", async () => {
      bulkProducts = [];
      const data = Array.from({ length: 5002 }, (_, i) => ({
        tenantId: tenantA,
        name: `R509 bulk ${i} ${run}`,
        unit: "EACH",
        pricePerUnit: "1.00",
      }));
      await raw.product.createMany({ data: data as never });
      bulkProducts = (
        await raw.product.findMany({
          where: { tenantId: tenantA, name: { startsWith: "R509 bulk" } },
          select: { id: true },
          orderBy: { name: "asc" },
        })
      ).map((r) => r.id);
      try {
        const rule = await create({ targets: { productIds: [p.a] } });
        // fill to 4,999 active targets directly
        await raw.sellingRestrictionTarget.createMany({
          data: bulkProducts.slice(0, 4998).map((productId) => ({
            tenantId: tenantA,
            ruleId: rule.id,
            productId,
            addedAt: PAST,
          })),
        });
        expect(
          await raw.sellingRestrictionTarget.count({ where: { ruleId: rule.id, removedAt: null } }),
        ).toBe(4999);
        await fails(
          asA(() =>
            targets.addTargets(
              rule.id,
              { productIds: [bulkProducts[4998], bulkProducts[4999]] },
              operator,
            ),
          ),
          400,
          { code: "RULE_TARGET_LIMIT", field: "rule", max: 5000 },
        );
        expect(await raw.sellingRestrictionTarget.count({ where: { ruleId: rule.id } })).toBe(4999);
        const ok = await asA(() =>
          targets.addTargets(rule.id, { productIds: [bulkProducts[4998]] }, operator),
        );
        expect(ok.activeTargets).toBe(5000);
        await fails(
          asA(() => targets.addTargets(rule.id, { productIds: [bulkProducts[4999]] }, operator)),
          400,
          { code: "RULE_TARGET_LIMIT", field: "rule" },
        );
      } finally {
        await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: tenantA } });
        await raw.sellingRestrictionRevision.deleteMany({ where: { tenantId: tenantA } });
        await raw.sellingRestriction.deleteMany({ where: { tenantId: tenantA } });
        await raw.product.deleteMany({
          where: { tenantId: tenantA, name: { startsWith: "R509 bulk" } },
        });
      }
    }, 120_000);

    it("more than 1,000 ids in one call is RULE_TARGET_LIMIT (field request)", async () => {
      const rule = await create({ targets: { productIds: [p.a] } });
      const ids = Array.from({ length: 1001 }, (_, i) => `x${i}`);
      await fails(
        asA(() => targets.addTargets(rule.id, { productIds: ids }, operator)),
        400,
        {
          code: "RULE_TARGET_LIMIT",
          field: "request",
          max: 1000,
        },
      );
    });

    it("an unknown, cross-tenant or archived id is RULE_TARGETS_NOT_FOUND and nothing is written", async () => {
      const rule = await create({ targets: { productIds: [p.a] } });
      await fails(
        asA(() =>
          targets.addTargets(
            rule.id,
            { productIds: [p.b, foreignProduct], categoryIds: [c.old] },
            operator,
          ),
        ),
        409,
        { code: "RULE_TARGETS_NOT_FOUND" },
      );
      expect(await allTargets(rule.id)).toHaveLength(1);
      expect(await audits("selling_restriction.targets_added")).toHaveLength(0);
    });

    it("another tenant's rule is a 404", async () => {
      const rule = await create({ targets: { productIds: [p.a] } });
      await fails(
        asB(() => targets.addTargets(rule.id, { productIds: [foreignProduct] }, admin)),
        404,
      );
      await fails(
        asB(() => targets.detail(rule.id)),
        404,
      );
    });

    it("a lifted rule is RULE_NOT_EDITABLE for add and remove", async () => {
      const rule = await create({ targets: { productIds: [p.a, p.b] } });
      await asA(() => rules.lift(rule.id, { reason: "done" }, admin));
      await fails(
        asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin)),
        409,
        {
          code: "RULE_NOT_EDITABLE",
        },
      );
      await fails(
        asA(() => targets.removeTargets(rule.id, { productIds: [p.a] }, admin)),
        409,
        {
          code: "RULE_NOT_EDITABLE",
        },
      );
      expect(await activeTargets(rule.id)).toHaveLength(2);
    });

    it("an expired rule is RULE_NOT_EDITABLE", async () => {
      const rule = await create({
        targets: { productIds: [p.a] },
        effectiveFrom: PAST.toISOString(),
        effectiveTo: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await fails(
        asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin)),
        409,
        {
          code: "RULE_NOT_EDITABLE",
        },
      );
    });

    it("SA condition 5: an operator adding to / removing from an all-customer rule is 403; an admin is fine", async () => {
      const rule = await create({
        jurisdiction: "FEDERAL",
        states: [],
        targets: { productIds: [p.a, p.b] },
      }); // all-customer, made by the admin
      await fails(
        asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, operator)),
        403,
      );
      await fails(
        asA(() => targets.removeTargets(rule.id, { productIds: [p.b] }, operator)),
        403,
      );
      expect(await activeTargets(rule.id)).toHaveLength(2);
      await asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin));
      await asA(() => targets.removeTargets(rule.id, { productIds: [p.b] }, admin));
      expect(await activeTargets(rule.id)).toHaveLength(2);
      // a STATE rule: operator ok both ways
      const state = await create(
        { jurisdiction: "STATE", states: ["TX"], targets: { productIds: [p.a] } },
        operator,
      );
      await asA(() => targets.addTargets(state.id, { productIds: [p.d] }, operator));
      await asA(() => targets.removeTargets(state.id, { productIds: [p.d] }, operator));
    });

    it("a variant added later is covered by a family target already in the rule (lineage), and a family id adds as ONE target", async () => {
      const rule = await create({ targets: { productIds: [p.a] } });
      await asA(() => targets.addTargets(rule.id, { productIds: [p.fam] }, operator));
      expect((await activeTargets(rule.id)).filter((t) => t.productId === p.fam)).toHaveLength(1);
      expect(await outcome("v1")).toBe("BLOCK");
      expect(await outcome("v2")).toBe("BLOCK");
    });
  });

  // ─── legacy rules (SA condition 1) ─────────────────────────────────────────────────────────────

  describe("a legacy rule with ZERO target rows", () => {
    it("its first add materialises the legacy target (addedAt = LEAST(createdAt, effectiveFrom)), so the legacy product stays blocked", async () => {
      const id = await legacyRule({ productId: p.legacy });
      expect(await outcome("legacy")).toBe("BLOCK"); // by its column
      await asA(() => targets.addTargets(id, { productIds: [p.legacy2] }, operator));
      const rows = await activeTargets(id);
      expect(rows).toHaveLength(2);
      const legacy = rows.find((r) => r.productId === p.legacy);
      expect(legacy).toBeDefined();
      expect(legacy?.addedAt.toISOString()).toBe(PAST.toISOString());
      expect(legacy?.addedById).toBe("u-legacy");
      expect(legacy?.addedByName).toBe("legacy-creator");
      expect(await outcome("legacy")).toBe("BLOCK"); // now by its target row
      expect(await outcome("legacy2")).toBe("BLOCK");
    });

    it("removing its only product is RULE_NEEDS_A_TARGET and the rule keeps blocking (nothing written, not even the materialised row)", async () => {
      const id = await legacyRule({ productId: p.legacy });
      await fails(
        asA(() => targets.removeTargets(id, { productIds: [p.legacy] }, operator)),
        409,
        {
          code: "RULE_NEEDS_A_TARGET",
        },
      );
      expect(await allTargets(id)).toHaveLength(0);
      expect(await outcome("legacy")).toBe("BLOCK");
    });

    it("removing one of two works after materialisation: the removed product stops blocking, the other still blocks", async () => {
      const id = await legacyRule({ productId: p.legacy });
      await asA(() => targets.addTargets(id, { productIds: [p.legacy2] }, operator));
      await asA(() => targets.removeTargets(id, { productIds: [p.legacy] }, operator));
      expect(await outcome("legacy")).toBe("ALLOW"); // the legacy column is ignored once target rows exist
      expect(await outcome("legacy2")).toBe("BLOCK");
    });

    it("detail shows the legacy target even before any target row exists", async () => {
      const id = await legacyRule({ productId: p.legacy });
      const d = await asA(() => targets.detail(id));
      expect(d.targets).toHaveLength(1);
      expect(d.targets[0]).toMatchObject({ kind: "PRODUCT", productId: p.legacy });
      expect(d.targetSummary).toMatchObject({ products: 1, categories: 0 });
    });
  });

  // ─── remove ────────────────────────────────────────────────────────────────────────────────────

  describe("POST :id/targets/remove", () => {
    it("stamps history rows (never deletes), defaults and trims the reason, reports notInRule, audits once", async () => {
      const rule = await create({
        targets: { productIds: [p.a, p.b, p.d], categoryIds: [c.vape] },
      });
      const res = await asA(() =>
        targets.removeTargets(rule.id, { productIds: [p.b, p.e], categoryIds: [c.vape] }, operator),
      );
      expect(res).toMatchObject({ removed: 2, notInRule: [p.e], activeTargets: 2 });
      const all = await allTargets(rule.id);
      expect(all).toHaveLength(4); // history is never deleted
      const b = all.find((t) => t.productId === p.b);
      expect(b?.removedAt).not.toBeNull();
      expect(b?.removedById).toBe(operator.sub);
      expect(b?.removedByName).toBe(operator.username);
      expect(b?.removeReason).toBe("Removed from rule");
      await asA(() =>
        targets.removeTargets(rule.id, { productIds: [p.d], reason: "  bad SKU  " }, operator),
      );
      expect((await allTargets(rule.id)).find((t) => t.productId === p.d)?.removeReason).toBe(
        "bad SKU",
      );
      const rows = await audits("selling_restriction.targets_removed", rule.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].meta).toMatchObject({
        ruleId: rule.id,
        count: 2,
        productIds: [p.b],
        categoryIds: [c.vape],
      });
      expect(await outcome("b")).toBe("ALLOW");
      expect(await outcome("a")).toBe("BLOCK");
      expect(await outcome("lab")).toBe("ALLOW");
    });

    it("removing the LAST active target is RULE_NEEDS_A_TARGET and nothing is written", async () => {
      const rule = await create({ targets: { productIds: [p.a, p.b] } });
      await fails(
        asA(() => targets.removeTargets(rule.id, { productIds: [p.a, p.b] }, operator)),
        409,
        { code: "RULE_NEEDS_A_TARGET" },
      );
      expect(await activeTargets(rule.id)).toHaveLength(2);
      expect(await audits("selling_restriction.targets_removed")).toHaveLength(0);
      expect(await outcome("a")).toBe("BLOCK");
    });

    it("an unknown or cross-tenant id is RULE_TARGETS_NOT_FOUND, nothing written", async () => {
      const rule = await create({ targets: { productIds: [p.a, p.b] } });
      await fails(
        asA(() => targets.removeTargets(rule.id, { productIds: [p.a, foreignProduct] }, operator)),
        409,
        { code: "RULE_TARGETS_NOT_FOUND" },
      );
      expect(await activeTargets(rule.id)).toHaveLength(2);
    });

    it("a removed product can be added back as a new row (history keeps the old one)", async () => {
      const rule = await create({ targets: { productIds: [p.a, p.b] } });
      await asA(() => targets.removeTargets(rule.id, { productIds: [p.b] }, operator));
      await asA(() => targets.addTargets(rule.id, { productIds: [p.b] }, operator));
      expect(await allTargets(rule.id)).toHaveLength(3);
      expect(await activeTargets(rule.id)).toHaveLength(2);
      expect(await outcome("b")).toBe("BLOCK");
    });
  });

  // ─── serialization ─────────────────────────────────────────────────────────────────────────────

  describe("the rule-row lock serializes target edits and lifts", () => {
    async function holdLock(
      ruleId: string,
    ): Promise<{ client: PoolClient; release: () => Promise<void> }> {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(`SELECT "id" FROM "SellingRestriction" WHERE "id" = $1 FOR UPDATE`, [
        ruleId,
      ]);
      return {
        client,
        release: async () => {
          await client.query("COMMIT");
          client.release();
        },
      };
    }
    const settledWithin = (p: Promise<unknown>, ms: number) =>
      Promise.race([
        p.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
      ]);

    it.each(["lift", "liftBatch", "add", "remove"] as const)(
      "%s WAITS for a transaction holding the rule's row lock, then runs after it",
      async (op) => {
        const rule = await create({ targets: { productIds: [p.a, p.b] } });
        const lock = await holdLock(rule.id);
        const call =
          op === "lift"
            ? asA(() => rules.lift(rule.id, { reason: "x" }, admin))
            : op === "liftBatch"
              ? asA(() => rules.liftBatch({ ids: [rule.id], reason: "x" }, admin))
              : op === "add"
                ? asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin))
                : asA(() => targets.removeTargets(rule.id, { productIds: [p.b] }, admin));
        expect(await settledWithin(call, 700)).toBe(false); // blocked on the lock
        expect(await raw.sellingRestrictionTarget.count({ where: { ruleId: rule.id } })).toBe(2);
        await lock.release();
        await call;
        const after = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
        if (op === "lift" || op === "liftBatch") expect(after.liftedAt).not.toBeNull();
        else expect(after.liftedAt).toBeNull();
      },
      30_000,
    );

    it("a lift that holds the lock makes a concurrent add fail RULE_NOT_EDITABLE with nothing written", async () => {
      const rule = await create({ targets: { productIds: [p.a, p.b] } });
      const lock = await holdLock(rule.id);
      await lock.client.query(
        `UPDATE "SellingRestriction" SET "liftedAt" = now() - interval '1 second' WHERE "id" = $1`,
        [rule.id],
      );
      const add = asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin));
      expect(await settledWithin(add, 500)).toBe(false);
      await lock.release();
      await fails(add, 409, { code: "RULE_NOT_EDITABLE" });
      expect(await allTargets(rule.id)).toHaveLength(2);
    }, 30_000);

    it("racing adds / removes / a lift never leave a half state: every outcome is consistent", async () => {
      for (let i = 0; i < 4; i++) {
        const rule = await create({ targets: { productIds: [p.a, p.b] } });
        const results = await Promise.allSettled([
          asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin)),
          asA(() => targets.addTargets(rule.id, { productIds: [p.d] }, admin)),
          asA(() => rules.lift(rule.id, { reason: "race" }, admin)),
        ]);
        const adds = results.slice(0, 2);
        const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
        expect(row.liftedAt).not.toBeNull(); // the lift always lands
        const dActive = (await activeTargets(rule.id)).filter((t) => t.productId === p.d);
        expect(dActive.length).toBeLessThanOrEqual(1); // never a duplicate active row
        const ok = adds.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
          added: number;
        }>[];
        expect(dActive.length).toBe(ok.some((r) => r.value.added === 1) ? 1 : 0);
        for (const r of adds.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
          expect((r.reason as HttpException).getResponse()).toMatchObject({
            code: "RULE_NOT_EDITABLE",
          });
        }
      }
    }, 60_000);
  });

  // ─── detail ────────────────────────────────────────────────────────────────────────────────────

  describe("GET :id", () => {
    it("returns the rule with names, sku, family flags, variant counts, label targets, and the history feed", async () => {
      const rule = await create({
        targets: { productIds: [p.fam, p.v1, p.a], categoryIds: [c.vape] },
      });
      await asA(() => targets.addTargets(rule.id, { productIds: [p.b] }, operator));
      await asA(() =>
        targets.removeTargets(rule.id, { productIds: [p.a], reason: "oops" }, operator),
      );
      const d = await asA(() => targets.detail(rule.id));
      expect(d.id).toBe(rule.id);
      // Row 509 PR3: a rule made through the service carries revision 1 (the rule as created).
      expect(d.revisions).toHaveLength(1);
      expect(d.revisions[0]).toMatchObject({
        revision: 1,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "BUYER_PORTAL",
        reason: "R509 PR2",
      });
      expect(d.nextCursor).toBeNull();
      expect(d.targets).toHaveLength(4); // fam, v1, vape, b (a was removed)
      const fam = d.targets.find((t) => t.productId === p.fam);
      expect(fam).toMatchObject({
        kind: "PRODUCT",
        isFamily: true,
        variantCount: 2,
        name: `R509 fam ${run}`,
      });
      expect(fam?.sku).toBe(`SKU-fam-${run}`);
      const v1 = d.targets.find((t) => t.productId === p.v1);
      expect(v1).toMatchObject({
        isFamily: false,
        variantCount: null,
        name: `R509 fam ${run} - Mango`,
      });
      const lab = d.targets.find((t) => t.categoryId === c.vape);
      expect(lab).toMatchObject({
        kind: "CATEGORY",
        productId: null,
        name: `Vape ${run}`,
        sku: null,
      });
      expect(d.targets.every((t) => t.id && t.addedAt && t.addedByName)).toBe(true);
      expect(d.targetEvents.map((e) => [e.kind, e.count])).toEqual([
        ["REMOVED", 1],
        ["ADDED", 1],
      ]);
      expect(d.targetEvents[0]).toMatchObject({ byName: operator.username, reason: "oops" });
      expect(d.targetSummary).toMatchObject({ products: 3, categories: 1 });
    });

    it("keyset-pages the targets in RULE_TARGETS_PAGE_SIZE (100) with an opaque cursor", async () => {
      const ids = Array.from({ length: 130 }, (_, i) => `x${i}`);
      const rows = await Promise.all(
        ids.map((_, i) =>
          mkProduct(tenantA, `page${i}`, {
            name: `R509 page ${String(i).padStart(3, "0")} ${run}`,
          }),
        ),
      );
      try {
        const rule = await create({ targets: { productIds: rows } });
        const first = await asA(() => targets.detail(rule.id));
        expect(first.targets).toHaveLength(100);
        expect(first.nextCursor).not.toBeNull();
        const second = await asA(() => targets.detail(rule.id, first.nextCursor ?? undefined));
        expect(second.targets).toHaveLength(30);
        expect(second.nextCursor).toBeNull();
        const seen = new Set([...first.targets, ...second.targets].map((t) => t.productId));
        expect(seen.size).toBe(130);
        await fails(
          asA(() => targets.detail(rule.id, "not-a-cursor")),
          400,
        );
      } finally {
        await raw.sellingRestrictionTarget.deleteMany({ where: { tenantId: tenantA } });
        await raw.sellingRestrictionRevision.deleteMany({ where: { tenantId: tenantA } });
        await raw.sellingRestriction.deleteMany({ where: { tenantId: tenantA } });
        await raw.product.deleteMany({
          where: { tenantId: tenantA, name: { startsWith: "R509 page" } },
        });
      }
    }, 60_000);
  });

  // ─── list / chips / holding / bulk / label guard ───────────────────────────────────────────────

  describe("who may lift", () => {
    const stateRule = () => create({ targets: { productIds: [p.a] } }); // STATE, operator-ok
    const allCustomerRule = () =>
      create({ jurisdiction: "FEDERAL", states: [], targets: { productIds: [p.b] } }); // admin-only

    it("an operator lifting an all-customer rule is 403 and the rule stays in force; an admin may lift it", async () => {
      const rule = await allCustomerRule();
      await fails(
        asA(() => rules.lift(rule.id, { reason: "no" }, operator)),
        403,
      );
      expect(
        (await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } })).liftedAt,
      ).toBeNull();
      expect(await audits("selling_restriction.lifted")).toHaveLength(0);
      await asA(() => rules.lift(rule.id, { reason: "ok" }, admin));
      expect(
        (await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } })).liftedAt,
      ).not.toBeNull();
    });

    it("an operator may lift a STATE rule", async () => {
      const rule = await stateRule();
      const dto = await asA(() => rules.lift(rule.id, { reason: "fine" }, operator));
      expect(dto.status).toBe("LIFTED");
    });

    it("lift-batch: one all-customer rule among the ids refuses the WHOLE batch for an operator, nothing changed", async () => {
      const state = await stateRule();
      const all = await allCustomerRule();
      await fails(
        asA(() => rules.liftBatch({ ids: [state.id, all.id], reason: "x" }, operator)),
        403,
      );
      for (const id of [state.id, all.id]) {
        expect(
          (await raw.sellingRestriction.findUniqueOrThrow({ where: { id } })).liftedAt,
        ).toBeNull();
      }
      expect(await audits("selling_restriction.batch_lifted")).toHaveLength(0);
      // an admin lifts both; an operator lifts a batch of STATE rules
      const res = await asA(() => rules.liftBatch({ ids: [state.id, all.id], reason: "x" }, admin));
      expect(res.lifted).toBe(2);
      const s1 = await stateRule();
      const s2 = await create({ targets: { productIds: [p.d] } });
      expect((await asA(() => rules.liftBatch({ ids: [s1.id, s2.id] }, operator))).lifted).toBe(2);
    });
  });

  describe("the rule's re-read after create is tenant-scoped", () => {
    it("create returns the rule it wrote (tenant in the where)", async () => {
      const dto = await create({ targets: { productIds: [p.a] } });
      expect(dto.tenantId).toBe(tenantA);
    });
  });

  describe("readers that moved to targets", () => {
    it("list: targetSummary counts and the first three names; a legacy rule summarises its column", async () => {
      const multi = await create({
        targets: { productIds: [p.a, p.b, p.d, p.e], categoryIds: [c.vape] },
      });
      const legacy = await legacyRule({ productId: p.legacy });
      const list = await asA(() => rules.list());
      const m = list.find((r) => r.id === multi.id);
      expect(m?.targetSummary).toMatchObject({ products: 4, categories: 1 });
      expect(m?.targetSummary?.preview).toHaveLength(3);
      const names = m?.targetSummary?.preview.map((x) => x.name) ?? [];
      expect([...names].sort()).toEqual(names); // by name
      const l = list.find((r) => r.id === legacy);
      expect(l?.targetSummary).toMatchObject({ products: 1, categories: 0 });
      expect(l?.targetSummary?.preview[0]).toMatchObject({ kind: "PRODUCT", id: p.legacy });
    });

    it("product chips reach a product through a direct target (PRODUCT), an ancestor's (PARENT), a label (CATEGORY) and a legacy column", async () => {
      const direct = await create({ targets: { productIds: [p.v1, p.a] } });
      const parent = await create({ targets: { productIds: [p.fam] } });
      const label = await create({ targets: { categoryIds: [c.cbd] } }); // v1 is labelled CBD
      const legacy = await legacyRule({ productId: p.v1 });
      const unrelated = await create({ targets: { productIds: [p.d] } });
      const res = await asA(() => rules.productLimits(p.v1));
      const by = new Map(res.items.map((i) => [i.id, i]));
      expect(by.get(direct.id)).toMatchObject({
        via: "PRODUCT",
        directTarget: true,
        viaLabel: null,
      });
      expect(by.get(direct.id)?.targetSummary).toMatchObject({ products: 2, categories: 0 });
      expect(by.get(parent.id)).toMatchObject({ via: "PARENT", viaLabel: `R509 fam ${run}` });
      expect(by.get(parent.id)?.directTarget).toBeFalsy();
      expect(by.get(label.id)).toMatchObject({ via: "CATEGORY", viaLabel: `CBD ${run}` });
      expect(by.get(legacy)).toMatchObject({ via: "PRODUCT", directTarget: true });
      expect(by.has(unrelated.id)).toBe(false);
      // a removed target stops showing
      await asA(() => targets.removeTargets(direct.id, { productIds: [p.v1] }, admin));
      const after = await asA(() => rules.productLimits(p.v1));
      expect(after.items.find((i) => i.id === direct.id)).toBeUndefined();
    });

    it("holding: ACTIVE / SCHEDULED rules holding >= 1 of the products as a DIRECT target, with the count", async () => {
      const two = await create({ targets: { productIds: [p.a, p.b, p.d] } });
      const one = await create({ targets: { productIds: [p.a], categoryIds: [c.vape] } });
      const sched = await create({
        targets: { productIds: [p.b] },
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const lifted = await create({ targets: { productIds: [p.a] } });
      await asA(() => rules.lift(lifted.id, { reason: "x" }, admin));
      const viaParent = await create({ targets: { productIds: [p.fam] } });
      const legacy = await legacyRule({ productId: p.b });
      const none = await create({ targets: { productIds: [p.e] } });
      const res = await asA(() => targets.holding({ productIds: [p.a, p.b, p.v1] }));
      const by = new Map(res.items.map((i) => [i.rule.id, i.holds]));
      expect(by.get(two.id)).toBe(2);
      expect(by.get(one.id)).toBe(1);
      expect(by.get(sched.id)).toBe(1);
      expect(by.get(legacy)).toBe(1);
      expect(by.has(lifted.id)).toBe(false);
      expect(by.has(viaParent.id)).toBe(false); // a parent's target is not a DIRECT hold of v1
      expect(by.has(none.id)).toBe(false);
      expect(res.items[0].holds).toBeGreaterThanOrEqual(res.items[res.items.length - 1].holds);
      expect(res.items.find((i) => i.rule.id === two.id)?.rule.targetSummary).toMatchObject({
        products: 3,
      });
      await fails(
        asA(() => targets.holding({ productIds: [] })),
        400,
      );
    });

    it("bulk creates ONE rule with all the products as targets (Q6); an identical live rule holding ALL skips it", async () => {
      const res = await asA(() =>
        rules.bulkCreate(
          { productIds: [p.a, p.b, p.d], jurisdiction: "STATE", states: ["TX"] } as never,
          operator,
        ),
      );
      expect(res).toMatchObject({ created: 1, skipped: 0 });
      expect(res.createdIds).toHaveLength(1);
      expect(res.ruleId).toBe(res.createdIds[0]);
      expect(res.auditId).toBeTruthy();
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(1);
      expect(await activeTargets(res.createdIds[0])).toHaveLength(3);
      expect(await audits("selling_restriction.bulk_created")).toHaveLength(1);
      // the same set again: skipped, nothing written
      const again = await asA(() =>
        rules.bulkCreate(
          { productIds: [p.d, p.a], jurisdiction: "STATE", states: ["TX"] } as never,
          operator,
        ),
      );
      expect(again).toMatchObject({ created: 0, skipped: 2, createdIds: [] });
      expect(again.skippedProductIds?.sort()).toEqual([p.a, p.d].sort());
      expect(again.ruleId).toBeUndefined();
      // a set the existing rule does NOT fully hold makes a new rule
      const wider = await asA(() =>
        rules.bulkCreate(
          { productIds: [p.a, p.e], jurisdiction: "STATE", states: ["TX"] } as never,
          operator,
        ),
      );
      expect(wider).toMatchObject({ created: 1, skipped: 0 });
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(2);
    });

    it("bulk with a cross-tenant product is RULE_TARGETS_NOT_FOUND and writes nothing", async () => {
      await fails(
        asA(() =>
          rules.bulkCreate(
            { productIds: [p.a, foreignProduct], jurisdiction: "STATE", states: ["TX"] } as never,
            operator,
          ),
        ),
        409,
        { code: "RULE_TARGETS_NOT_FOUND" },
      );
      expect(await raw.sellingRestriction.count({ where: { tenantId: tenantA } })).toBe(0);
    });

    it("the label archive guard counts rules that hold the label as a TARGET (and legacy zero-target rules by column)", async () => {
      const targeted = await create({ targets: { productIds: [p.a], categoryIds: [c.vape] } });
      const list = await asA(() => categories.list());
      expect(list.find((l) => l.id === c.vape)?.activeRestrictionCount).toBe(1);
      expect(list.find((l) => l.id === c.cbd)?.activeRestrictionCount).toBe(0);
      await fails(
        asA(() => categories.update(c.vape, { archived: true } as never, admin)),
        409,
      );
      // a legacy rule on the other label, by column
      const legacy = await legacyRule({ categoryId: c.cbd });
      expect(
        (await asA(() => categories.list())).find((l) => l.id === c.cbd)?.activeRestrictionCount,
      ).toBe(1);
      await fails(
        asA(() => categories.update(c.cbd, { archived: true } as never, admin)),
        409,
      );
      // the label removed from the rule no longer blocks archiving it
      await asA(() => targets.removeTargets(targeted.id, { categoryIds: [c.vape] }, admin));
      const done = await asA(() => categories.update(c.vape, { archived: true } as never, admin));
      expect(done.archivedAt).not.toBeNull();
      await raw.productCategory.update({ where: { id: c.vape }, data: { archivedAt: null } });
      await raw.sellingRestriction.update({
        where: { id: legacy },
        data: { liftedAt: new Date() },
      });
      expect(
        (await asA(() => categories.list())).find((l) => l.id === c.cbd)?.activeRestrictionCount,
      ).toBe(0);
    });
  });
});
