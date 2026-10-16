import { ExecutionContext } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { PaymentDueService } from "./payment-due.service";

/**
 * SA-801: the card reminder for a stub-free catch-up, through the REAL planner, the REAL service and the REAL claim
 * (only the database and Stripe are stand-ins). A tenant that has already paid October (paid coverage lands exactly
 * on the 1st the card starts billing on) is the planner's `trial` shape: nothing is due now, but the card must be
 * added before that 1st. The reminder's Add card is the very catch-up session, charged $0 now.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const NOV_1 = "2026-11-01T12:00:00.000Z";
/** SA-806: D = A - 72 h, the last instant the quoted terms hold. */
const OCT_29 = "2026-10-29T12:00:00.000Z";
const HOUR = 3600_000;
const OCT_PAID = {
  id: "inv_oct",
  tenantId: "t1",
  status: "PAID",
  number: "RF-1",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "k1",
};
const OCT_OPEN = { ...OCT_PAID, id: "inv_oct_open", status: "OPEN", periodKey: "k2" };

function make(
  tenantStatus = "ACTIVE",
  invoices: Record<string, unknown>[] = [OCT_PAID],
  monthly = 310,
) {
  const db = fakeCatchupDb({ subs: [{ tenantId: "t1", planKey: "GROWTH" }], invoices });
  const prisma: any = {
    ...db.prisma,
    tenantAddon: { findMany: jest.fn(async () => []) },
    tenantConfig: { findUnique: jest.fn(async () => ({ timezone: "America/New_York" })) },
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "qa-acme",
        status: tenantStatus,
        class: "PRODUCTION",
        deletedAt: null,
      })),
    },
  };
  const stripe = fakeStripeCatchup();
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({
      planKey: "GROWTH",
      monthly,
      source: "catalog",
      currency: "usd",
    })),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: Math.round(monthly * 100),
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
  const svc = new PaymentDueService(prisma, catchup, claim, stripe as any);
  return { svc, db, stripe };
}

describe("SA-801: a trial-shape tenant (October already paid)", () => {
  it("today: no payment due; with the reminder: cardNeeded with A's instant", async () => {
    const { svc } = make();
    expect(await svc.get("t1", NOW)).toEqual({
      due: false,
      pastDue: false,
      amountCents: 0,
      periodLabel: null,
      periodStart: null,
      cardNeeded: true,
      chargeStartsOn: NOV_1,
      cardBy: OCT_29,
    });
  });

  it("control: an unpaid October is due and needs no reminder (so the cases prove the shape)", async () => {
    const { svc } = make("ACTIVE", [OCT_OPEN]);
    expect(await svc.get("t1", NOW)).toMatchObject({
      due: true,
      cardNeeded: false,
      chargeStartsOn: null,
      cardBy: null,
    });
  });

  it("Add card creates exactly ONE session that charges $0 now (trial_end = A, recurring lines only); a second click reuses it", async () => {
    const { svc, db, stripe } = make();
    const first = await svc.pay("t1", NOW);
    expect(first.checkoutUrl).toMatch(/^https:\/\/pay\.test\/cs_catchup/);
    const create = stripe.client.checkout.sessions.create as jest.Mock;
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(0);
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data.billing_cycle_anchor).toBeUndefined();
    expect(params.metadata.catchup_stub_cents).toBe("0");
    expect(params.metadata.catchup_shape).toBe("trial");
    expect(db.subs[0].catchupState).toBe("SESSION_OPEN");

    // Stripe's live session (the fake carries no url or expiry of its own)
    const id = String(db.subs[0].catchupSessionId);
    const live = (stripe as any).sessions[id];
    live.url = first.checkoutUrl;
    live.expires_at = Math.floor(NOW.getTime() / 1000) + 3600;
    const second = await svc.pay("t1", NOW);
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("Add card returns to ?paid=1&card=1 (never the payment wording: nothing is charged)", async () => {
    const { svc, stripe } = make();
    await svc.pay("t1", NOW);
    const params = (stripe.client.checkout.sessions.create as jest.Mock).mock.calls[0][0];
    expect(params.success_url).toMatch(/\/settings\/billing\?paid=1&card=1$/);
  });

  it("the reminder stays on while the session is open (a held claim does not hide it)", async () => {
    const { svc } = make();
    await svc.pay("t1", NOW);
    expect(await svc.get("t1", NOW)).toMatchObject({ due: false, cardNeeded: true });
  });
});

describe("SA-801: who gets no reminder, and what pay does for them", () => {
  it.each(["TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED"])(
    "%s: cardNeeded false, pay() is 409 PAYMENT_NOT_DUE, nothing created or written",
    async (status) => {
      const { svc, db, stripe } = make(status);
      expect(await svc.get("t1", NOW)).toMatchObject({
        due: false,
        cardNeeded: false,
        chargeStartsOn: null,
        cardBy: null,
      });
      await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.PAYMENT_NOT_DUE },
      });
      expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.calls).toEqual([]);
      expect(db.subs[0].catchupState).toBeNull();
      expect(db.audits).toHaveLength(0);
      expect(db.locks).toHaveLength(0);
    },
  );

  it("a READ_ONLY tenant's POST is still refused by the read-only guard (the allow-list is unchanged)", async () => {
    const findUnique = jest.fn().mockResolvedValue({ status: "READ_ONLY", readOnlyReason: null });
    const guard = new TenantStatusGuard({ tenant: { findUnique } } as any);
    const token = `h.${Buffer.from(JSON.stringify({ tenantId: "t1", role: "TENANT_ADMIN" })).toString("base64url")}.s`;
    const req = {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      path: "/api/v1/billing/payment-due/pay",
    };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      response: expect.objectContaining({ code: API_ERROR_CODES.READ_ONLY }),
    });
  });
});

describe("SA-806 R1/R2: the quoted terms hold until D = A - 72 h", () => {
  it("R1: at A - 73 h the reminder is on, with A as the charge date and D as the card deadline", async () => {
    const { svc } = make();
    const at = new Date(Date.parse(NOV_1) - 73 * HOUR);
    expect(await svc.get("t1", at)).toMatchObject({
      due: false,
      cardNeeded: true,
      chargeStartsOn: NOV_1,
      cardBy: OCT_29,
    });
  });

  it("R2 (guard): at A - 71 h there is no card reminder; the next month is simply due (not past due)", async () => {
    const { svc } = make();
    const at = new Date(Date.parse(NOV_1) - 71 * HOUR);
    expect(await svc.get("t1", at)).toEqual({
      due: true,
      pastDue: false,
      amountCents: 31000,
      periodLabel: "November 2026",
      periodStart: NOV_1,
      cardNeeded: false,
      chargeStartsOn: null,
      cardBy: null,
    });
  });

  it("the exact edge: at D the reminder still shows, one second later it is the next month's bill", async () => {
    const { svc } = make();
    expect(await svc.get("t1", new Date(OCT_29))).toMatchObject({ cardNeeded: true, due: false });
    expect(await svc.get("t1", new Date(Date.parse(OCT_29) + 1000))).toMatchObject({
      cardNeeded: false,
      due: true,
    });
  });
});

describe("SA-806 R4: a forgiven stub (a line under $0.50) gets the reminder and a $0 Add card", () => {
  // $0.10 a month and October unpaid: the planner's stub is 10 cents, forgiven, so the session carries no one-time line
  const forgiven = () => make("ACTIVE", [], 0.1);

  it("the reminder shows A and D (master: no banner and pay() was a 409 PAYMENT_NOT_DUE)", async () => {
    const { svc } = forgiven();
    expect(await svc.get("t1", NOW)).toEqual({
      due: false,
      pastDue: false,
      amountCents: 0,
      periodLabel: null,
      periodStart: null,
      cardNeeded: true,
      chargeStartsOn: NOV_1,
      cardBy: OCT_29,
    });
  });

  it("Add card opens ONE session with no one-time line and $0 due now; a second click reuses it", async () => {
    const { svc, db, stripe } = forgiven();
    const first = await svc.pay("t1", NOW);
    const create = stripe.client.checkout.sessions.create as jest.Mock;
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(0);
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.metadata.catchup_stub_cents).toBe("0");
    expect(params.success_url).toMatch(/\/settings\/billing\?paid=1&card=1$/);
    expect(db.subs[0].catchupState).toBe("SESSION_OPEN");

    const id = String(db.subs[0].catchupSessionId);
    const live = (stripe as any).sessions[id];
    live.url = first.checkoutUrl;
    live.expires_at = Math.floor(NOW.getTime() / 1000) + 3600;
    expect(await svc.pay("t1", NOW)).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("SA-806a guard: a $0-priced manual-invoicing tenant has no banner and no pay", () => {
  it("get() is not due and not cardNeeded; pay() is 409 PAYMENT_NOT_DUE with nothing created", async () => {
    const { svc, db, stripe } = make("ACTIVE", [], 0);
    expect(await svc.get("t1", NOW)).toEqual({
      due: false,
      pastDue: false,
      amountCents: 0,
      periodLabel: null,
      periodStart: null,
      cardNeeded: false,
      chargeStartsOn: null,
      cardBy: null,
    });
    await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_NOT_DUE },
    });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.calls).toEqual([]);
    expect(db.subs[0].catchupState).toBeNull();
  });
});
