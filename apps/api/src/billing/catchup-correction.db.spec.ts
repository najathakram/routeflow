/**
 * SA-1122 (i) / D14 PR-1 against real Postgres (DB lane): CatchupCorrectionService writes the three correction markers
 * under the Tenant row lock, and the REAL planner (CatchupCheckoutService.plan) reads them back. Throwaway `qa-*`
 * tenants only; Stripe is never called (the stateful fake). Mirrors catchup-correction-markers.db.spec.ts fixtures.
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
import { CatchupCorrectionService } from "./catchup-correction.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const CORRECTION_ACTIONS = [
  "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
  "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE",
  "TENANT_BILLING_START_OVERRIDE",
];
const NOW = new Date("2026-10-13T10:00:00Z");
const START = "2026-10-12T04:08:24Z";
const END = "2026-11-11T04:08:24Z";

describeDb("SA-1122 catch-up corrections (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });
  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma.$disconnect();
    await pool.end();
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
        meta: { platformAdmin: true, ...meta } as any,
        createdAt: new Date(createdAt),
      },
    });

  /** A manual tenant whose one activation recorded "paid Oct 12 -> Nov 11". */
  async function tenant(tag: string) {
    const slug = `qa-cc-${tag}-${run}`;
    assertTestTenant(slug, "catchup-correction.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE } as any,
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: t.id, planKey: "ENTERPRISE", externalPayment: true } as any,
    });
    const marker = await audit(t.id, "TENANT_MANUAL_ACTIVATION_MARKER", START, {
      periodStart: START,
      periodEnd: END,
    });
    await audit(t.id, "TENANT_SUBSCRIPTION_ACTIVATED", "2026-10-12T04:08:27Z", { periodEnd: END });
    return { id: t.id, name: slug, markerId: marker.id };
  }

  function corrections() {
    const stripe = fakeStripeCatchup();
    const claim = new CatchupClaimService(
      prisma as any,
      stripe as any,
      new BillingEventService(prisma as any),
    );
    const checkout = new CatchupCheckoutService(
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
      { ensureStripeCustomer: async () => "cus_cc" } as any,
    );
    return new CatchupCorrectionService(prisma as any, checkout);
  }
  const rows = (tenantId: string) =>
    prisma.auditLog.count({ where: { tenantId, action: { in: CORRECTION_ACTIONS } } });
  const body = (
    t: { name: string },
    expectedBefore: number | null,
    over: Record<string, unknown> = {},
  ) =>
    ({
      reason: "the owner states nothing was paid",
      expectedBefore,
      confirmTenantName: t.name,
      ...over,
    }) as any;

  it("C1: a void writes exactly one VOID row and the next plan changes (before and after observed)", async () => {
    const t = await tenant("c1");
    const svc = corrections();
    const before = await svc.view(t.id, NOW);
    expect(before.markers).toMatchObject([{ id: t.markerId, state: "counts" }]);

    const preview = await svc.preview(t.id, { voidCoverage: [t.markerId] }, NOW);
    expect(preview.before?.stubCents).toBe(before.summary?.stubCents);
    expect(await rows(t.id)).toBe(0); // a preview writes nothing

    const out = await svc.apply(
      t.id,
      body(t, before.summary?.stubCents ?? null, { voidCoverage: [t.markerId] }),
      "admin-1",
      NOW,
    );
    expect(out.appended).toHaveLength(1);
    expect(await rows(t.id)).toBe(1);
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: out.appended[0] } });
    expect(row).toMatchObject({
      action: "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
      tenantId: t.id,
      entityType: ADMIN_AUDIT_ENTITY,
    });
    expect(row.meta).toMatchObject({
      platformAdmin: true,
      voidsMarkerId: t.markerId,
      actor: "admin-1",
      ownerApprovedAt: NOW.toISOString(),
    });

    const after = await svc.view(t.id, NOW);
    expect(after.markers).toMatchObject([{ id: t.markerId, state: "voided" }]);
    expect(after.summary).not.toEqual(before.summary);
    console.log(
      `C1 observed: before ${JSON.stringify(before.summary)} -> after ${JSON.stringify(after.summary)}`,
    );
  });

  it("a restore undoes the void (latest row wins) and a billing start is recorded", async () => {
    const t = await tenant("restore");
    const svc = corrections();
    const v0 = await svc.view(t.id, NOW);
    await svc.apply(
      t.id,
      body(t, v0.summary?.stubCents ?? null, { voidCoverage: [t.markerId] }),
      "a",
      NOW,
    );
    const v1 = await svc.view(t.id, NOW);
    await svc.apply(
      t.id,
      body(t, v1.summary?.stubCents ?? null, { restoreCoverage: [t.markerId] }),
      "a",
      NOW,
    );
    const v2 = await svc.view(t.id, NOW);
    expect(v2.markers[0].state).toBe("restored");
    expect(v2.summary).toEqual(v0.summary);
    await svc.apply(
      t.id,
      body(t, v2.summary?.stubCents ?? null, { billingStart: "2026-10-01" }),
      "a",
      NOW,
    );
    const v3 = await svc.view(t.id, NOW);
    expect(v3.billingStartOverride).toMatchObject({ valid: true });
    expect(await rows(t.id)).toBe(3);
  });

  it("C2: a held claim is 409 CATCHUP_CLAIM_HELD and no row is written", async () => {
    const t = await tenant("c2");
    const svc = corrections();
    const v = await svc.view(t.id, NOW);
    for (const state of ["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"]) {
      await prisma.tenantSubscription.update({
        where: { tenantId: t.id },
        data: { catchupState: state } as any,
      });
      await expect(
        svc.apply(
          t.id,
          body(t, v.summary?.stubCents ?? null, { voidCoverage: [t.markerId] }),
          "a",
          NOW,
        ),
      ).rejects.toMatchObject({ response: { code: "CATCHUP_CLAIM_HELD" } });
      expect(await rows(t.id)).toBe(0);
    }
  });

  it("C3, C4, C5, C9 and a bad billing start each write zero rows", async () => {
    const t = await tenant("refusals");
    const other = await tenant("other");
    const svc = corrections();
    const v = await svc.view(t.id, NOW);
    const cents = v.summary?.stubCents ?? null;
    const stale = (cents ?? 0) + 1;
    const c3 = svc.apply(
      t.id,
      body(t, cents, { voidCoverage: [t.markerId], restoreCoverage: [t.markerId] }),
      "a",
      NOW,
    );
    await expect(c3).rejects.toMatchObject({ response: { code: "CATCHUP_CORRECTION_CONFLICT" } });
    await expect(
      svc.apply(t.id, body(t, cents, { voidCoverage: [other.markerId] }), "a", NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.apply(t.id, body(t, stale, { voidCoverage: [t.markerId] }), "a", NOW),
    ).rejects.toMatchObject({ response: { code: "CATCHUP_PREVIEW_STALE" } });
    await expect(
      svc.apply(
        t.id,
        body(t, cents, { voidCoverage: [t.markerId], confirmTenantName: "wrong" }),
        "a",
        NOW,
      ),
    ).rejects.toBeDefined();
    await expect(
      svc.apply(t.id, body(t, cents, { billingStart: "2026-10-02" }), "a", NOW),
    ).rejects.toMatchObject({ response: { code: "CATCHUP_BILLING_START_INVALID" } });
    expect(await rows(t.id)).toBe(0);
    expect(await rows(other.id)).toBe(0);
  });

  it("two tabs: the second apply with the old amount is 409 CATCHUP_PREVIEW_STALE", async () => {
    const t = await tenant("tabs");
    const svc = corrections();
    const v = await svc.view(t.id, NOW);
    const cents = v.summary?.stubCents ?? null;
    await svc.apply(t.id, body(t, cents, { voidCoverage: [t.markerId] }), "a", NOW);
    await expect(
      svc.apply(t.id, body(t, cents, { voidCoverage: [t.markerId] }), "a", NOW),
    ).rejects.toMatchObject({ response: { code: "CATCHUP_PREVIEW_STALE" } });
    expect(await rows(t.id)).toBe(1);
  });
});
