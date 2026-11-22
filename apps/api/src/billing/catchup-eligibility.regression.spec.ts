import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { PaymentDueService } from "./payment-due.service";
import { effectiveCycle, nextBillingWindow } from "./rf-invoice/calendar-windows";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";

/**
 * SA-1210 G1 (#4404'): who is ELIGIBLE for the card catch-up is decided by one planner, from the paid coverage on
 * record (paid RfInvoices and manual-activation markers). The subscription row's own `periodEnd` is the CURRENT
 * billing window, not a paid period: the nightly roll moves every external row whose window ended, paid or not, and
 * writes no marker. These two businesses owe money and must stay eligible whatever their row's window says. They were
 * refused by SA-1206 R1 (a guard that read `periodEnd` as "paid through").
 */
const iso = (d: Date) => d.toISOString();

function harness(o: {
  now: Date;
  sub: Record<string, unknown>;
  invoices?: Record<string, unknown>[];
  activation?: { start: string; end: string };
}) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: "t1", planKey: "GROWTH", ...o.sub }],
    invoices: o.invoices ?? [],
  });
  if (o.activation) {
    const at = new Date(o.activation.start);
    db.audits.push(
      {
        tenantId: "t1",
        entityType: "tenant",
        action: "TENANT_MANUAL_ACTIVATION_MARKER",
        createdAt: at,
        meta: {
          periodStart: at.toISOString(),
          periodEnd: new Date(o.activation.end).toISOString(),
        },
      },
      {
        tenantId: "t1",
        entityType: "tenant",
        action: "TENANT_SUBSCRIPTION_ACTIVATED",
        createdAt: new Date(at.getTime() + 3000),
        meta: { periodEnd: new Date(o.activation.end).toISOString() },
      },
    );
  }
  const prisma: any = {
    ...db.prisma,
    tenantAddon: { findMany: jest.fn(async () => []) },
    tenantConfig: { findUnique: jest.fn(async () => ({ timezone: "America/Chicago" })) },
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "qa-acme",
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
      })),
    },
  };
  const stripe = fakeStripeCatchup();
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({
      planKey: "GROWTH",
      monthly: 310,
      source: "catalog",
      currency: "usd",
    })),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: 31000,
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Growth" },
    })),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [], invalid: [] })),
    recordInvalidCatalogAddons: jest.fn(async () => undefined),
  };
  const claim = new CatchupClaimService(prisma, stripe as any, { emit: jest.fn() } as any);
  const billing: any = { ensureStripeCustomer: jest.fn(async () => "cus_1") };
  const catchup = new CatchupCheckoutService(
    prisma,
    stripe as any,
    pricing,
    mutations,
    claim,
    billing,
  );
  const due = new PaymentDueService(prisma, catchup, claim, stripe as any);
  return { catchup, due };
}

describe("a business that owes money stays eligible (SA-1210 G1, #4404')", () => {
  it("one month behind: October PAID, November an OPEN RF invoice, now Nov 9, row [Nov 1, Dec 1) -> eligible, line starts Nov 1, Pay banner due", async () => {
    const now = new Date("2026-11-09T10:00:00Z");
    const h = harness({
      now,
      sub: {
        periodStart: new Date("2026-11-01T12:00:00Z"),
        periodEnd: new Date("2026-12-01T12:00:00Z"),
      },
      invoices: [
        {
          id: "inv_oct",
          tenantId: "t1",
          status: "PAID",
          number: "RF-1",
          periodStart: new Date("2026-10-01T12:00:00Z"),
          periodEnd: new Date("2026-11-01T12:00:00Z"),
          periodKey: "k1",
        },
        {
          id: "inv_nov",
          tenantId: "t1",
          status: "OPEN",
          number: "RF-2",
          periodStart: new Date("2026-11-01T12:00:00Z"),
          periodEnd: new Date("2026-12-01T12:00:00Z"),
          periodKey: "k2",
        },
      ],
    });
    const r = await h.catchup.plan("t1", now);
    expect(r.ineligible).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok).toBe(true);
    if (!r.plan.ok) return;
    expect(iso(r.plan.stub.from)).toBe("2026-11-01T12:00:00.000Z");
    expect(iso(r.plan.stub.to)).toBe("2026-12-01T12:00:00.000Z");

    const banner = await h.due.get("t1", now);
    expect(banner.due).toBe(true);
    expect(banner.periodStart).toBe("2026-11-01T12:00:00.000Z");
  });

  it("the day after a mid-month activation ends: activation 10/27 to 11/26, now 11/27, the row rolled by the real nextBillingWindow -> eligible, S = 11/26", async () => {
    const now = new Date("2026-11-27T10:00:00Z");
    const activationEnd = new Date("2026-11-26T12:00:00Z");
    const rolled = nextBillingWindow(
      activationEnd,
      effectiveCycle("MONTHLY", new Date("2026-10-27T12:00:00Z"), activationEnd),
    );
    const h = harness({
      now,
      sub: { periodStart: rolled.periodStart, periodEnd: rolled.periodEnd },
      activation: { start: "2026-10-27T12:00:00Z", end: "2026-11-26T12:00:00Z" },
    });
    const r = await h.catchup.plan("t1", now);
    expect(r.ineligible).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok).toBe(true);
    if (!r.plan.ok) return;
    expect(iso(r.plan.paidThrough)).toBe("2026-11-26T12:00:00.000Z");
    expect(iso(r.plan.stub.from)).toBe("2026-11-26T12:00:00.000Z");
  });
});
