import { Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { BillingStatusService, WARNED_TENANTS_CAP } from "./billing-status.service";
import { seesBillingMoney } from "./subscription-billing-extras";

/** SA-1150: the one money predicate, the SUPER_ADMIN case (S4), the stale-marker log (S11) and the warn cap (S19). */

const NO_DUE = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};
const CARD = { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 };
const OWED = {
  status: "ACTIVE",
  trialEndsAt: null,
  readOnlyReason: null,
  pastDueInvoiceId: null,
  pastDueSince: null,
  paymentMethodSummary: CARD,
  nextCharge: null,
  billingState: "due",
  outstandingTotal: 149,
  payNowAmount: 149,
};

function make(subscription: unknown = OWED, paymentDue: unknown = NO_DUE) {
  const svc = new BillingStatusService(
    { getSubscription: jest.fn().mockResolvedValue(subscription) } as never,
    { get: jest.fn().mockResolvedValue(paymentDue) } as never,
    {
      tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "America/Chicago" }) },
    } as never,
  );
  return svc;
}

describe("seesBillingMoney (the one predicate beside trimBillingViewForRole)", () => {
  it.each([
    [UserRole.TENANT_ADMIN, true],
    [UserRole.SUPER_ADMIN, true],
    [UserRole.OPERATOR, false],
    [UserRole.DRIVER, false],
    [undefined, false],
    [null, false],
  ])("%s -> %s", (role, want) => {
    expect(seesBillingMoney(role as string | null | undefined)).toBe(want);
  });
});

describe("BillingStatusService", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("S4: a SUPER_ADMIN under a tenant gets exactly what a TENANT_ADMIN gets", async () => {
    const svc = make();
    const admin = await svc.get("t1", UserRole.TENANT_ADMIN);
    const sa = await svc.get("t1", UserRole.SUPER_ADMIN);
    expect(sa).toEqual(admin);
    expect(admin).toEqual({
      state: "due",
      amount: 149,
      dueOn: null,
      action: { kind: "pay", target: "hosted_invoice" },
    });
  });

  it("an OPERATOR gets the same state with no Stripe amount and no action", async () => {
    expect(await make().get("t1", UserRole.OPERATOR)).toEqual({
      state: "due",
      amount: null,
      dueOn: null,
      action: null,
    });
  });

  it("S11: a dunning marker that lags a current answer says none and warns once per tenant", async () => {
    const svc = make({
      ...OWED,
      billingState: "current",
      pastDueInvoiceId: "in_1",
      pastDueSince: "2026-11-10T20:00:00.000Z",
      nextCharge: { amount: 49.5, date: "2026-12-01T03:00:00.000Z" },
    });
    const view = await svc.get("t1", UserRole.TENANT_ADMIN);
    await svc.get("t1", UserRole.TENANT_ADMIN);
    expect(view).toEqual({ state: "none", amount: null, dueOn: null, action: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("S19: the warn set is capped (the oldest tenant is forgotten, so it warns again)", async () => {
    const svc = make(OWED, { ...NO_DUE, due: true, amountCents: 100 });
    for (let i = 0; i <= WARNED_TENANTS_CAP; i++) await svc.get(`t${i}`, UserRole.OPERATOR);
    expect(warn).toHaveBeenCalledTimes(WARNED_TENANTS_CAP + 1);
    await svc.get("t0", UserRole.OPERATOR); // evicted by the cap
    expect(warn).toHaveBeenCalledTimes(WARNED_TENANTS_CAP + 2);
    await svc.get(`t${WARNED_TENANTS_CAP}`, UserRole.OPERATOR); // newest still remembered
    expect(warn).toHaveBeenCalledTimes(WARNED_TENANTS_CAP + 2);
  });
});
