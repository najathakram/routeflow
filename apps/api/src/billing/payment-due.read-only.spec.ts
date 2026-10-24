import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { PaymentDueService } from "./payment-due.service";

/**
 * Row 542, F7: the read-only guard does NOT let a READ_ONLY (or suspended, or cancelled) tenant pay through the
 * payment-due route. Making billing read-only payable is a separate row; until then:
 *  - the real catch-up planner refuses every non-ACTIVE tenant (`tenant_not_active`), so the banner's read says
 *    `due: false` and a direct `pay()` is 409 PAYMENT_NOT_DUE with nothing written or created;
 *  - POST /billing/payment-due/pay is refused by the global guard with the coded READ_ONLY 403 (reason carried).
 * Real planner, real service, real guard; only the database and Stripe are stand-ins.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const OCT_OPEN = {
  id: "inv_oct_open",
  tenantId: "t1",
  status: "OPEN",
  number: "RF-1",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "k2",
};

function make(tenantStatus: string) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: "t1", planKey: "GROWTH" }],
    invoices: [OCT_OPEN],
  });
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
  const svc = new PaymentDueService(prisma, catchup, claim, stripe as any);
  return { svc, db, stripe, billing };
}

function guardFor(status: string, readOnlyReason: string | null) {
  const findUnique = jest.fn().mockResolvedValue({ status, readOnlyReason });
  return { guard: new TenantStatusGuard({ tenant: { findUnique } } as any), findUnique };
}

const token = `h.${Buffer.from(JSON.stringify({ tenantId: "t1", role: "TENANT_ADMIN" })).toString("base64url")}.s`;
function ctx(method: string, path: string): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${token}` }, method, path };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const READ_ONLY_REASONS: Array<string | null> = [
  null,
  "trial_expired",
  "trial_cancelled",
  "payment_overdue",
  "subscription_cancelled",
];

describe("a tenant that is not ACTIVE has no payment due (the planner's own refusal)", () => {
  it("control: the same data on an ACTIVE tenant IS due (so the cases below prove the status, not the fixture)", async () => {
    const { svc } = make("ACTIVE");
    expect(await svc.get("t1", NOW)).toMatchObject({ due: true, amountCents: 31000 });
  });

  it.each(["READ_ONLY", "SUSPENDED", "CANCELLED"])(
    "%s: GET reads due:false, and pay() is 409 PAYMENT_NOT_DUE with nothing created or written",
    async (status) => {
      const { svc, db, stripe } = make(status);
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
      expect(db.audits).toHaveLength(0);
      expect(db.locks).toHaveLength(0);
    },
  );
});

describe("POST /billing/payment-due/pay is refused by the read-only guard (billing read-only payable is a separate row)", () => {
  it.each(READ_ONLY_REASONS)(
    "READ_ONLY (reason %p): the guard refuses with the coded READ_ONLY 403 and the handler is never reached",
    async (reason) => {
      const { guard } = guardFor("READ_ONLY", reason);
      const handler = jest.fn();
      const err = await guard
        .canActivate(ctx("POST", "/api/v1/billing/payment-due/pay"))
        .then((ok) => {
          if (ok) handler();
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: API_ERROR_CODES.READ_ONLY, reason }),
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["SUSPENDED", "CANCELLED"])("%s: refused too", async (status) => {
    const { guard } = guardFor(status, null);
    await expect(
      guard.canActivate(ctx("POST", "/api/v1/billing/payment-due/pay")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the READ-side of the same tenant still passes the guard (GET payment-due), so the banner can say due:false", async () => {
    const { guard } = guardFor("READ_ONLY", "trial_expired");
    await expect(guard.canActivate(ctx("GET", "/api/v1/billing/payment-due"))).resolves.toBe(true);
  });

  it("an ACTIVE tenant's pay passes the guard", async () => {
    const { guard } = guardFor("ACTIVE", null);
    await expect(guard.canActivate(ctx("POST", "/api/v1/billing/payment-due/pay"))).resolves.toBe(
      true,
    );
  });
});
