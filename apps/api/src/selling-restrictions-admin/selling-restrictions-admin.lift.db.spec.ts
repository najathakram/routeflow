/**
 * Lane R step 5a-3 — DB lane for rule LIFT (the real-Postgres follow-up to #1068).
 * What a mocked prisma cannot prove: the `updateMany where { id, liftedAt: null }` guard really is
 * the arbiter of two concurrent lifts (exactly one wins, the other is a 409, one audit row, and the
 * stored reason is the winner's); a double lift never overwrites the first; another tenant's rule is
 * a 404 and stays untouched; the write touches only the lift columns (effectiveTo as authored); the
 * list's LIFTED status and the engine's own `activeRuleWhere` both see the change.
 * (The 403 for a non-admin is the controller's RolesGuard metadata — pinned in the unit spec.)
 *
 * Run via `npm run local:test:db`. Every tenant is a throwaway `qa-lift-<run>-*` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const admin = { sub: "u-lift-admin", username: "lift-admin" } as JwtPayload;

describeDb("selling-restriction lift against real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: SellingRestrictionsAdminService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-lift-${run}-a`, "selling-restrictions-admin.lift.db.spec.ts");
  const slugB = assertTestTenant(`qa-lift-${run}-b`, "selling-restrictions-admin.lift.db.spec.ts");
  let tenantA: string;
  let tenantB: string;
  let categoryA: string;

  const asA = <T>(fn: () => Promise<T>) => ctx.run(tenantA, fn);
  const asB = <T>(fn: () => Promise<T>) => ctx.run(tenantB, fn);
  const seedRule = (tenantId: string, extra: Record<string, unknown> = {}) =>
    raw.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: categoryA,
        jurisdiction: "FEDERAL",
        states: [],
        reason: "seed",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        ...extra,
      },
    });
  const liftAudits = (entityId: string) =>
    raw.auditLog.findMany({
      where: { entityId, action: "selling_restriction.lifted" },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new SellingRestrictionsAdminService(prisma, new ProductLabelsService(prisma));
    const ta = await raw.tenant.create({ data: { slug: slugA, name: `Lift spec ${slugA}` } });
    const tb = await raw.tenant.create({ data: { slug: slugB, name: `Lift spec ${slugB}` } });
    tenantA = ta.id;
    tenantB = tb.id;
    categoryA = (await raw.productCategory.create({ data: { tenantId: tenantA, name: "Hemp" } }))
      .id;
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.sellingRestriction.deleteMany({ where: { tenantId: t } });
      await raw.productCategory.deleteMany({ where: { tenantId: t } });
      await raw.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("a lift writes only the lift columns, audits once, and the list + the engine both see it", async () => {
    const effectiveTo = new Date("2099-01-01T00:00:00Z");
    const rule = await seedRule(tenantA, { effectiveTo });
    const before = new Date();
    expect(
      await raw.sellingRestriction.count({ where: { id: rule.id, ...activeRuleWhere(before) } }),
    ).toBe(1);

    const dto = await asA(() => service.lift(rule.id, { reason: "law changed" }, admin));
    expect(dto.status).toBe("LIFTED");

    const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.liftedAt).not.toBeNull();
    expect(row.liftedById).toBe(admin.sub);
    expect(row.liftedByName).toBe(admin.username);
    expect(row.liftReason).toBe("law changed");
    expect(row.effectiveTo?.toISOString()).toBe(effectiveTo.toISOString()); // as authored
    expect(row.reason).toBe("seed");

    expect(await liftAudits(rule.id)).toHaveLength(1);
    // The engine's own predicate no longer matches it (the rule stops applying at once).
    expect(
      await raw.sellingRestriction.count({
        where: { id: rule.id, ...activeRuleWhere(new Date()) },
      }),
    ).toBe(0);
    const listed = await asA(() => service.list("LIFTED"));
    expect(listed.map((r) => r.id)).toContain(rule.id);
  }, 30_000);

  it("a second lift is a 409 and never overwrites the first (reason, actor, time)", async () => {
    const rule = await seedRule(tenantA);
    await asA(() => service.lift(rule.id, { reason: "first" }, admin));
    const first = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });

    await expect(
      asA(() =>
        service.lift(rule.id, { reason: "second" }, { sub: "u2", username: "two" } as JwtPayload),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const after = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.liftReason).toBe("first");
    expect(after.liftedById).toBe(admin.sub);
    expect(after.liftedAt?.toISOString()).toBe(first.liftedAt?.toISOString());
    expect(await liftAudits(rule.id)).toHaveLength(1);
  }, 30_000);

  it("concurrent lifts: exactly one 201-equivalent and one 409, one audit row, the winner's reason stored", async () => {
    for (let i = 0; i < 6; i++) {
      const rule = await seedRule(tenantA);
      const results = await Promise.allSettled([
        asA(() => service.lift(rule.id, { reason: "left" }, admin)),
        asA(() =>
          service.lift(rule.id, { reason: "right" }, { sub: "u2", username: "two" } as JwtPayload),
        ),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(ConflictException);
      const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
      const winnerIdx = results[0].status === "fulfilled" ? 0 : 1;
      expect(row.liftReason).toBe(winnerIdx === 0 ? "left" : "right");
      expect(await liftAudits(rule.id)).toHaveLength(1);
    }
  }, 60_000);

  it("another tenant's rule is a 404 and is left untouched", async () => {
    const rule = await seedRule(tenantA);
    await expect(
      asB(() => service.lift(rule.id, { reason: "not mine" }, admin)),
    ).rejects.toBeInstanceOf(NotFoundException);
    const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.liftedAt).toBeNull();
    expect(row.liftReason).toBeNull();
    expect(await liftAudits(rule.id)).toHaveLength(0);
  }, 30_000);

  it("a scheduled (future-dated) rule can be lifted — i.e. cancelled — and never applies", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const rule = await seedRule(tenantA, { effectiveFrom: future });
    await asA(() => service.lift(rule.id, { reason: "cancelled" }, admin));
    const row = await raw.sellingRestriction.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.liftedAt).not.toBeNull();
    expect(
      await raw.sellingRestriction.count({
        where: { id: rule.id, ...activeRuleWhere(new Date(future.getTime() + 1000)) },
      }),
    ).toBe(0);
  }, 30_000);
});
