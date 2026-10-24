/**
 * DB-lane spec (SA-736r M1/F3/F4): the single coupon-column writer against REAL Postgres - the CAS, the
 * couponSyncedAt lost-update guard, the Tenant row lock ordering and the ledger crossing, with concurrent
 * writers. Each case uses its own throwaway `qa-*` tenant.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingEventService } from "./billing-event.service";
import { applyCouponState, resetCouponState } from "./coupon-state";
import { NO_COUPON } from "./coupon-unbilled";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("applyCouponState - the single writer (SA-736r, real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let deps: { prisma: any; events: BillingEventService };
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  async function tenantWithSub(tag: string, over: Record<string, unknown> = {}) {
    const slug = assertTestTenant(`qa-cpn-${tag}-${run}`, "coupon-state.db.spec.ts");
    const t = await raw.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await raw.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "STARTER",
        basePriceSnapshot: 99,
        discount: 0,
        stripeSubId: `sub_qa_${tag}_${run}`,
        ...over,
      },
    });
    return t.id;
  }
  const ledgerSum = async (tenantId: string) =>
    Number(
      (await raw.billingEvent.aggregate({ where: { tenantId }, _sum: { amountDelta: true } }))._sum
        .amountDelta ?? 0,
    );
  const subOf = (tenantId: string) =>
    raw.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });

  beforeAll(() => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    deps = { prisma: raw, events: new BillingEventService(raw as any) };
  });

  afterAll(async () => {
    if (raw) await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw?.$disconnect();
    await pool?.end();
  });

  it("entry books -X once, exit +X once; a replay adds none; the columns and the stamp are written", async () => {
    const id = await tenantWithSub("rt");
    await raw.tenantAddon.create({
      data: {
        tenantId: id,
        addonKey: "advanced_routes",
        sku: "ADVANCED_ROUTES",
        quantity: 1,
        priceSnapshot: 20,
        active: true,
      },
    });
    const t1 = new Date(Date.now() - 5000);
    const r1 = await applyCouponState(
      deps,
      id,
      { full: true, couponId: "cp_qa", endsAt: null },
      { reason: "t", syncedAt: t1 },
    );
    expect(r1.amountDelta).toBe(-119);
    expect(await subOf(id)).toMatchObject({ couponFull: true, couponId: "cp_qa" });
    expect((await subOf(id)).couponSyncedAt?.getTime()).toBe(t1.getTime());

    const again = await applyCouponState(
      deps,
      id,
      { full: true, couponId: "cp_qa", endsAt: null },
      { reason: "t", syncedAt: new Date(Date.now() - 4000) },
    );
    expect(again.amountDelta).toBe(0);
    expect(await ledgerSum(id)).toBe(-119);

    await applyCouponState(deps, id, NO_COUPON, {
      reason: "t",
      syncedAt: new Date(Date.now() - 3000),
    });
    expect(await ledgerSum(id)).toBe(0);
    expect((await subOf(id)).couponFull).toBe(false);
  });

  it("F4: an older read that commits later is a no-op against the real column", async () => {
    const id = await tenantWithSub("f4");
    await applyCouponState(deps, id, NO_COUPON, {
      reason: "newer",
      syncedAt: new Date(Date.now() - 1000),
    });
    const stale = await applyCouponState(
      deps,
      id,
      { full: true, couponId: "cp", endsAt: null },
      { reason: "older", syncedAt: new Date(Date.now() - 9000) },
    );
    expect(stale).toMatchObject({ applied: false, stale: true });
    expect((await subOf(id)).couponFull).toBe(false);
    expect(await ledgerSum(id)).toBe(0);
  });

  it("concurrent writers serialize on the Tenant lock: the ledger always equals the final state (30 races)", async () => {
    for (let i = 0; i < 30; i++) {
      const id = await tenantWithSub(`race${i}`);
      const base = Date.now() - 60_000;
      await Promise.all([
        applyCouponState(
          deps,
          id,
          { full: true, couponId: "cp", endsAt: null },
          { reason: "a", syncedAt: new Date(base + 10) },
        ),
        applyCouponState(deps, id, NO_COUPON, { reason: "b", syncedAt: new Date(base + 20) }),
        applyCouponState(
          deps,
          id,
          { full: true, couponId: "cp", endsAt: null },
          { reason: "c", syncedAt: new Date(base + 30) },
        ),
      ]);
      const row = await subOf(id);
      // Whatever the order, a paying row books 0 and an unbilled row books -99: never -198, never +99.
      expect(await ledgerSum(id)).toBe(row.couponFull ? -99 : 0);
    }
  }, 60_000);

  it("a reset books the in-tx before/after: resetting a SUSPENDED coupon tenant books 0; an ACTIVE one +X", async () => {
    const idSusp = await tenantWithSub("susp", { couponFull: true });
    await raw.tenant.update({ where: { id: idSusp }, data: { status: TenantStatus.SUSPENDED } });
    await resetCouponState(deps, idSusp, "stripe_subscription_deleted");
    expect(await ledgerSum(idSusp)).toBe(0);
    expect((await subOf(idSusp)).couponFull).toBe(false);

    const idActive = await tenantWithSub("act", { couponFull: true });
    await resetCouponState(deps, idActive, "stripe_sub_replaced");
    expect(await ledgerSum(idActive)).toBe(99);
  });

  it("M5 race (real rows): a full=true write that raced an admin's switch to manual billing is forced false - no -X", async () => {
    const id = await tenantWithSub("manual");
    // the sync read externalPayment=false; before its write commits the admin activates manual billing
    await raw.tenantSubscription.update({
      where: { tenantId: id },
      data: { externalPayment: true },
    });
    const r = await applyCouponState(
      deps,
      id,
      { full: true, couponId: "cp", endsAt: null },
      { reason: "sync", syncedAt: new Date(Date.now() - 1000) },
    );
    expect(r.amountDelta).toBe(0);
    expect((await subOf(id)).couponFull).toBe(false);
    expect(await ledgerSum(id)).toBe(0);
  });

  it("the Tenant lock is taken first: a held Tenant FOR UPDATE makes the writer wait, then complete", async () => {
    const id = await tenantWithSub("lock");
    let released = false;
    const holder = raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      released = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    await applyCouponState(
      deps,
      id,
      { full: true, couponId: "cp", endsAt: null },
      { reason: "wait", syncedAt: new Date(Date.now() - 100) },
    );
    expect(released).toBe(true); // the writer could not finish before the holder released the Tenant row
    await holder;
    expect((await subOf(id)).couponFull).toBe(true);
  });
});
