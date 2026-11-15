import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PrismaService } from "../prisma/prisma.service";
import { BillingStatusController } from "./billing-status.controller";
import { PaymentDueService } from "./payment-due.service";
import { SubscriptionService } from "./subscription.service";

/** SA-1146 B-5: the role rule on the wire. Mocked at the module boundary (subscription, payment-due, zone). */

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

/** An owed Stripe invoice inside dunning: the admin's `failed` state, with the full (untrimmed) subscription read. */
const FAILED_SUBSCRIPTION = {
  status: "ACTIVE",
  trialEndsAt: null,
  readOnlyReason: null,
  pastDueInvoiceId: "in_1",
  pastDueSince: "2026-11-10T20:00:00.000Z",
  paymentMethodSummary: { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 },
  nextCharge: null,
  billingState: "overdue",
  outstandingTotal: 59.5,
};

async function make(subscription: unknown = FAILED_SUBSCRIPTION, paymentDue: unknown = NO_DUE) {
  const subscriptionSvc = { getSubscription: jest.fn().mockResolvedValue(subscription) };
  const paymentDueSvc = { get: jest.fn().mockResolvedValue(paymentDue) };
  const prisma = {
    tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "America/Chicago" }) },
  };
  const mod = await Test.createTestingModule({
    controllers: [BillingStatusController],
    providers: [
      { provide: SubscriptionService, useValue: subscriptionSvc },
      { provide: PaymentDueService, useValue: paymentDueSvc },
      { provide: PrismaService, useValue: prisma },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return {
    controller: mod.get(BillingStatusController),
    subscriptionSvc,
    paymentDueSvc,
  };
}

describe("GET /billing/status: the role rule", () => {
  it("an OPERATOR gets the sentence state and amount with action null", async () => {
    const { controller } = await make();
    const view = await controller.get({ tenantId: "t1", role: UserRole.OPERATOR });
    expect(view).toEqual({ state: "failed", amount: 59.5, dueOn: "2026-11-24", action: null });
  });

  it("a TENANT_ADMIN gets the same state with the Pay action to the hosted invoice", async () => {
    const { controller } = await make();
    const view = await controller.get({ tenantId: "t1", role: UserRole.TENANT_ADMIN });
    expect(view).toEqual({
      state: "failed",
      amount: 59.5,
      dueOn: "2026-11-24",
      action: { kind: "pay", target: "hosted_invoice" },
    });
  });

  it("reads the tenant from the JWT and never an operator's trimmed copy (the amount comes through)", async () => {
    const { controller, subscriptionSvc, paymentDueSvc } = await make();
    await controller.get({ tenantId: "t9", role: UserRole.OPERATOR });
    expect(subscriptionSvc.getSubscription).toHaveBeenCalledWith("t9");
    expect(paymentDueSvc.get).toHaveBeenCalledWith("t9", expect.any(Date));
  });

  it("a user with no tenant context is refused", async () => {
    const { controller } = await make();
    await expect(controller.get({ tenantId: null, role: UserRole.SUPER_ADMIN })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("the catch-up bill reaches an admin as Pay to the checkout and an operator as no action", async () => {
    const { controller } = await make(
      {
        ...FAILED_SUBSCRIPTION,
        pastDueInvoiceId: null,
        billingState: undefined,
        outstandingTotal: undefined,
      },
      { ...NO_DUE, due: true, amountCents: 4999, periodStart: "2026-11-01T05:00:00.000Z" },
    );
    const admin = await controller.get({ tenantId: "t1", role: UserRole.TENANT_ADMIN });
    const staff = await controller.get({ tenantId: "t1", role: UserRole.OPERATOR });
    expect(admin.action).toEqual({ kind: "pay", target: "checkout" });
    expect(staff).toEqual({ ...admin, action: null });
  });
});

describe("GET /billing/status: the route is OPERATOR and up", () => {
  it("declares @Roles(OPERATOR) at the class and no tighter role on get", () => {
    expect(Reflect.getMetadata(ROLES_KEY, BillingStatusController)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, BillingStatusController.prototype.get)).toBeUndefined();
  });
});
