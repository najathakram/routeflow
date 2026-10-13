import { BadRequestException, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { SettingsBillingController } from "./settings-billing.controller";

/**
 * SA-733r6 (B4): the admin-only billing portal / pay link, and the role-trimmed subscription view.
 * The role rule is proved at the guard (RolesGuard over the real handler metadata), not just by reading a decorator.
 */
function make(opts: { portal?: jest.Mock; pay?: jest.Mock; view?: any } = {}) {
  const subscription = {
    getSubscription: jest.fn().mockResolvedValue(opts.view ?? {}),
    openInvoiceUrl: opts.pay ?? jest.fn().mockResolvedValue("https://invoice.example/i/1"),
  } as any;
  const billing = {
    createBillingPortalSession:
      opts.portal ?? jest.fn().mockResolvedValue({ portalUrl: "https://billing.example/p/1" }),
  } as any;
  const controller = new SettingsBillingController(subscription, {} as any, {} as any, billing);
  return { controller, subscription, billing };
}

describe("SettingsBillingController.createPortal (B4: admin-only portal)", () => {
  const handlerCtx = (user: any) =>
    ({
      getHandler: () => SettingsBillingController.prototype.createPortal,
      getClass: () => SettingsBillingController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;
  const rolesGuard = new RolesGuard(new Reflector());

  it("RolesGuard admits a TENANT_ADMIN and refuses OPERATOR, DRIVER, CUSTOMER and a role-less user", () => {
    expect(rolesGuard.canActivate(handlerCtx({ role: "TENANT_ADMIN" }))).toBe(true);
    for (const role of ["OPERATOR", "DRIVER", "CUSTOMER", undefined]) {
      expect(rolesGuard.canActivate(handlerCtx({ role }))).toBe(false);
    }
    // an operator who can also drive is still not an admin
    expect(rolesGuard.canActivate(handlerCtx({ role: "OPERATOR", canActAsDriver: true }))).toBe(
      false,
    );
  });

  it("the handler's own role metadata is exactly [TENANT_ADMIN]", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, SettingsBillingController.prototype.createPortal);
    expect(roles).toEqual([UserRole.TENANT_ADMIN]);
  });

  it("returns the portal URL and the open invoice's hosted URL, the Stripe calls capped (#2476)", async () => {
    const { controller, billing, subscription } = make();
    const out = await controller.createPortal({ tenantId: "t1", sub: "u1" } as any);
    expect(out).toEqual({
      portalUrl: "https://billing.example/p/1",
      hostedInvoiceUrl: "https://invoice.example/i/1",
    });
    expect(billing.createBillingPortalSession).toHaveBeenCalledWith("t1", undefined, {
      timeoutMs: expect.any(Number),
      maxNetworkRetries: expect.any(Number),
    });
    expect(subscription.openInvoiceUrl).toHaveBeenCalledWith("t1");
  });

  it("a portal failure does NOT lose the pay link", async () => {
    const { controller } = make({ portal: jest.fn().mockRejectedValue(new Error("stripe")) });
    expect(await controller.createPortal({ tenantId: "t1" } as any)).toEqual({
      portalUrl: null,
      hostedInvoiceUrl: "https://invoice.example/i/1",
    });
  });

  it("a pay-link failure does NOT lose the portal", async () => {
    const { controller } = make({ pay: jest.fn().mockRejectedValue(new Error("stripe")) });
    expect(await controller.createPortal({ tenantId: "t1" } as any)).toEqual({
      portalUrl: "https://billing.example/p/1",
      hostedInvoiceUrl: null,
    });
  });

  it("neither available (no Stripe customer / external payment): a coded 4xx, never a 500", async () => {
    const { controller } = make({
      portal: jest
        .fn()
        .mockRejectedValue(new BadRequestException("Tenant does not have a Stripe customer.")),
      pay: jest.fn().mockResolvedValue(null),
    });
    const err: any = await controller.createPortal({ tenantId: "t1" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse().code).toBe("BILLING_PORTAL_UNAVAILABLE");
  });

  it("both fail on a Stripe outage: a coded 503 (retryable), never a bare 500", async () => {
    const { controller } = make({
      portal: jest.fn().mockRejectedValue(new Error("Stripe is not configured")),
      pay: jest.fn().mockRejectedValue(new Error("boom")),
    });
    const err: any = await controller.createPortal({ tenantId: "t1" } as any).catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse().code).toBe("BILLING_PORTAL_UNAVAILABLE");
  });

  it("no tenant context (SUPER_ADMIN) -> 403, never a null tenant into the query layer", async () => {
    const { controller } = make();
    await expect(controller.createPortal({ tenantId: null } as any)).rejects.toThrow(
      "requires a tenant context",
    );
  });
});

// S3: the Stripe-backed extras are an admin's business. An operator keeps the contact's e-mail (who to ask) and the
// owed marker (the strip exists) but never the card, the next charge or the amount.
describe("SettingsBillingController.getSubscription - role-trimmed view (B4 S3)", () => {
  const view = {
    status: "READ_ONLY",
    pastDueInvoiceId: "in_1",
    billingContactEmail: "dana@acme.test",
    openInvoiceAmount: 149,
    paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 10, expYear: 2026 },
    nextCharge: { amount: 149, date: "2026-12-01T00:00:00.000Z", dateLabel: "Dec 1" },
  };

  it.each(["OPERATOR", "DRIVER", "CUSTOMER", undefined])(
    "%s: card, next charge and amount are null",
    async (role) => {
      const { controller } = make({ view: { ...view } });
      const out: any = await controller.getSubscription({ tenantId: "t1", role } as any);
      expect(out.paymentMethodSummary).toBeNull();
      expect(out.nextCharge).toBeNull();
      expect(out.openInvoiceAmount).toBeNull();
      // SA-776: the contact's e-mail is what a non-admin is told to write to - the role trim keeps it
      expect(out.billingContactEmail).toBe("dana@acme.test");
      expect(out.pastDueInvoiceId).toBe("in_1");
    },
  );

  it("TENANT_ADMIN keeps everything", async () => {
    const { controller } = make({ view: { ...view } });
    const out: any = await controller.getSubscription({
      tenantId: "t1",
      role: "TENANT_ADMIN",
    } as any);
    expect(out).toEqual(view);
  });
});
