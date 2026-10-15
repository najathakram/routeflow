/**
 * SA-733r11 (row 385) - the correction markers against real Postgres (DB lane; WRITTEN in phase 1, run by the lane
 * lead). The pilot tenant: a manual activation recorded "paid Oct 12 -> Nov 11" that never happened, voided by a
 * COVERAGE_VOID marker, with a BILLING_START_OVERRIDE of Oct 1 12:00Z. Throwaway `qa-*` tenant, Stripe untouched
 * (plan() and open() are driven with the stateful fake). Mirrors catchup-claim.db.spec.ts fixtures.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ADMIN_AUDIT_ENTITY } from "../platform-admin/audit-actions.constant";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { BillingEventService } from "./billing-event.service";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-733r11 correction markers (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });
  afterAll(async () => {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function tenant(tag: string) {
    const slug = assertTestTenant(`qa-cm-${tag}-${run}`, "catchup-correction-markers.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: t.id, planKey: "ENTERPRISE", externalPayment: true },
    });
    return t.id;
  }
  const rfInvoice = (tenantId: string, start: string, end: string) =>
    prisma.rfInvoice.create({
      data: {
        tenantId,
        number: `RF-2099-${run}-${++seq}`,
        amount: 100,
        status: "OPEN",
        periodStart: new Date(start),
        periodEnd: new Date(end),
        periodKey: new Date(start).toISOString(),
        dueDate: new Date(start),
      },
    });
  const audit = (
    tenantId: string,
    action: string,
    createdAt: string,
    meta: Record<string, unknown>,
  ) =>
    prisma.auditLog.create({
      data: {
        tenantId,
        action,
        entityType: ADMIN_AUDIT_ENTITY,
        entityId: tenantId,
        meta: meta as any,
        createdAt: new Date(createdAt),
      },
    });

  function checkoutFor() {
    const stripe = fakeStripeCatchup();
    const claim = new CatchupClaimService(
      prisma as any,
      stripe as any,
      new BillingEventService(prisma as any),
    );
    const svc = new CatchupCheckoutService(
      prisma as any,
      stripe as any,
      {
        resolveTenantPricing: async () => ({
          planKey: "ENTERPRISE",
          monthly: 100,
          source: "override",
          currency: "usd",
        }),
        checkoutPriceData: async () => ({
          currency: "usd",
          unit_amount: 10000,
          recurring: { interval: "month" },
          product_data: { name: "RouteFlow Enterprise - monthly" },
        }),
      } as any,
      { checkoutAddonLines: async () => ({ lineItems: [], skus: [], invalid: [] }) } as any,
      claim,
      { ensureStripeCustomer: async () => "cus_cm" } as any,
    );
    return { svc, stripe };
  }

  it("the pilot tenant: a voided first activation + billingStart Oct 1 -> S = Oct 1 12:00Z, A = Nov 1 12:00Z, stub $100.00; the original marker rows are untouched", async () => {
    const id = await tenant("pilot");
    const START = "2026-10-12T04:08:24Z";
    const END = "2026-11-11T04:08:24Z";
    const marker = await audit(id, "TENANT_MANUAL_ACTIVATION_MARKER", START, {
      periodStart: START,
      periodEnd: END,
    });
    await audit(id, "TENANT_SUBSCRIPTION_ACTIVATED", "2026-10-12T04:08:27Z", { periodEnd: END });
    await audit(id, "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID", "2026-10-13T08:00:00Z", {
      voidsMarkerId: marker.id,
      reason: "owner states nothing was paid",
      actor: "sa-1",
      ownerApprovedAt: "2026-10-13T07:55:00.000Z",
    });
    await audit(id, "TENANT_BILLING_START_OVERRIDE", "2026-10-13T08:05:00Z", {
      billingStart: "2026-10-01T12:00:00.000Z",
      reason: "owner rule: billing starts Oct 1",
      actor: "sa-1",
      ownerApprovedAt: "2026-10-13T07:55:00.000Z",
    });
    const oct = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const nov = await rfInvoice(id, "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z");

    const before = await prisma.auditLog.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: "asc" },
    });
    const { svc } = checkoutFor();
    const r = await svc.plan(id, new Date("2026-10-13T10:00:00Z"));
    expect(r.ineligible).toEqual([]);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) throw new Error("unreachable");
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(r.plan.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(10000);
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.voidInvoiceIds.sort()).toEqual([oct.id, nov.id].sort());

    // append-only: planning wrote nothing and the original rows are unchanged
    const after = await prisma.auditLog.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("with NO correction markers the same activation is paid coverage (S = Nov 11): the markers are what change the plan", async () => {
    const id = await tenant("plain");
    const START = "2026-10-12T04:08:24Z";
    const END = "2026-11-11T04:08:24Z";
    await audit(id, "TENANT_MANUAL_ACTIVATION_MARKER", START, {
      periodStart: START,
      periodEnd: END,
    });
    await audit(id, "TENANT_SUBSCRIPTION_ACTIVATED", "2026-10-12T04:08:27Z", { periodEnd: END });
    const { svc } = checkoutFor();
    const r = await svc.plan(id, new Date("2026-10-13T10:00:00Z"));
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-11-11T04:08:24.000Z");
  });
});
