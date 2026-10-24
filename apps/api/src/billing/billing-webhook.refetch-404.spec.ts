/**
 * F1a at the ledger: a customer.subscription.updated whose re-fetch gets a Stripe 404 is NOT read as deleted. The
 * handler throws (after alerting ops), so the webhook answers 500 and the ledger row is left `error:` - FAILED,
 * claimable by Stripe's redelivery - never `processed`. The controller and BillingService are the real classes;
 * Stripe and the database are mocks.
 */
import { HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BillingService } from "./billing.service";
import { BillingWebhookController } from "./billing-webhook.controller";

const T_INSERT = new Date("2026-10-13T05:00:00.000Z");

function build() {
  const sub = {
    tenantId: "t1",
    stripeSubId: "sub_1",
    stripeCustomerId: "cus_1",
    tenant: { id: "t1", slug: "acme", name: "Acme" },
  };
  const event = {
    id: "evt_u1",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1", customer: "cus_1", status: "active" } },
  };
  const stripe: any = {
    isConfigured: true,
    constructWebhookEvent: jest.fn(() => event),
    getSubscription: jest.fn().mockRejectedValue(
      Object.assign(new Error("No such subscription"), {
        code: "resource_missing",
        statusCode: 404,
      }),
    ),
  };
  const dbOfBilling: any = {
    tenantSubscription: { findFirst: jest.fn().mockResolvedValue(sub), update: jest.fn() },
    tenant: { updateMany: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  const billing = new BillingService(
    dbOfBilling,
    stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const ledger: any = {
    $queryRaw: jest.fn(async (q: Prisma.Sql) =>
      /^INSERT/i.test(q.sql.trim()) ? [{ processedAt: T_INSERT }] : [],
    ),
    stripeBillingEvent: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const controller = new BillingWebhookController(stripe, billing, ledger);
  const json = jest.fn();
  const res: any = { status: jest.fn().mockReturnValue({ json }) };
  const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
  return { controller, res, req, ledger, dbOfBilling };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("handleEvent leaves the ledger FAILED when the re-fetch 404s (F1a)", () => {
  it("answers 500, records an error: outcome (never processed), alerts ops, changes nothing", async () => {
    const { controller, res, req, ledger, dbOfBilling } = build();
    await controller.handleWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const write = ledger.stripeBillingEvent.updateMany.mock.calls[0][0];
    expect(write.where).toEqual({ id: "evt_u1", outcome: null, processedAt: T_INSERT });
    expect(write.data.outcome).toMatch(/^error:/);
    expect(write.data.outcome).not.toBe("processed");
    const alert = dbOfBilling.auditLog.create.mock.calls.find(
      (c: any[]) => c[0].data.action === "STRIPE_SUBSCRIPTION_NOT_FOUND",
    );
    expect(alert?.[0].data.meta).toMatchObject({ platformAdmin: true, stripeEventId: "evt_u1" });
    expect(dbOfBilling.tenantSubscription.update).not.toHaveBeenCalled();
    expect(dbOfBilling.tenant.updateMany).not.toHaveBeenCalled();
  });
});
