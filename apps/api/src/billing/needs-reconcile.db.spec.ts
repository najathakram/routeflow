/**
 * SA-733r3 N4 — the REAL needsReconcile writes against Postgres: arm (Tenant lock -> flag -> audit row in one
 * transaction), ownership, clear, mark. Throwaway `qa-*` tenants. DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  armNeedsReconcile,
  clearNeedsReconcile,
  markNeedsReconcile,
  NEEDS_RECONCILE_ARMED_KIND,
} from "./needs-reconcile";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("needsReconcile (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const logger = { error: jest.fn(), warn: jest.fn() };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function tenant(tag: string): Promise<string> {
    const slug = assertTestTenant(`qa-nr-${tag}-${run}`, "needs-reconcile.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({ data: { tenantId: t.id, planKey: "GROWTH" } });
    return t.id;
  }
  const flag = async (id: string) =>
    (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } })).needsReconcile;
  const deps = () => ({ prisma: prisma as any, logger });

  it("arm raises the flag and writes ONE audit row with the key and the attempt nonce; clear lowers it", async () => {
    const id = await tenant("arm");
    expect(await flag(id)).toBe(false);

    const armed = await armNeedsReconcile(deps(), {
      tenantId: id,
      kind: "plan_change",
      key: `${id}:plan-change:v1:n-1`,
      nonce: "n-1",
      stripeSubId: "sub_x",
    });
    expect(armed).toEqual({ owned: true });
    expect(await flag(id)).toBe(true);
    const rows = await prisma.auditLog.findMany({ where: { tenantId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({
      kind: NEEDS_RECONCILE_ARMED_KIND,
      idempotencyKey: `${id}:plan-change:v1:n-1`,
      attemptNonce: "n-1",
      alreadyFlagged: false,
    });

    await clearNeedsReconcile(deps(), id, armed);
    expect(await flag(id)).toBe(false);
  });

  it("a second attempt on a flagged row does not own the flag: its clear leaves it up", async () => {
    const id = await tenant("own");
    const first = await armNeedsReconcile(deps(), { tenantId: id, kind: "plan_change", key: "k1" });
    const second = await armNeedsReconcile(deps(), {
      tenantId: id,
      kind: "price_override",
      key: "k2",
    });
    expect([first.owned, second.owned]).toEqual([true, false]);
    await clearNeedsReconcile(deps(), id, second);
    expect(await flag(id)).toBe(true);
    await clearNeedsReconcile(deps(), id, first);
    expect(await flag(id)).toBe(false);
  });

  it("mark raises the flag and nothing clears it but a human / reconciler", async () => {
    const id = await tenant("mark");
    await markNeedsReconcile(deps(), { tenantId: id, key: "k", error: "revert refused" });
    expect(await flag(id)).toBe(true);
    await clearNeedsReconcile(deps(), id, { owned: false });
    expect(await flag(id)).toBe(true);
  });
});
