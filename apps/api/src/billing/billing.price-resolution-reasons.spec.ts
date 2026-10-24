/**
 * Go-live MUST 2: `syncStripeSubscriptionPrice` tells a business refusal from resolveTenantPricing (an
 * HttpException: no fee, unknown plan, missing tenant) apart from an infrastructure failure (a database blip, a
 * timeout, an unknown Error). Only the first is `price_unresolvable` (alerted and acknowledged by the checkout
 * webhook); the second is `pricing_lookup_failed`, a transient reason that makes the webhook throw so Stripe
 * redelivers.
 */
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BillingService } from "./billing.service";

function make(resolve: () => Promise<unknown>) {
  return new BillingService(
    {} as any,
    { isConfigured: true } as any,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    { resolveTenantPricing: jest.fn(resolve) } as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("price resolution failures get the right reason", () => {
  it.each([
    ["BadRequest (no catalog price / no custom fee)", () => new BadRequestException("no fee")],
    ["NotFound (no such tenant)", () => new NotFoundException("gone")],
  ])("%s -> price_unresolvable", async (_n, err) => {
    const svc = make(async () => {
      throw err();
    });
    await expect(svc.syncStripeSubscriptionPrice("t1")).resolves.toEqual({
      synced: false,
      reason: "price_unresolvable",
    });
  });

  it.each([
    [
      "a Prisma known request error",
      () =>
        new Prisma.PrismaClientKnownRequestError("Can't reach database", {
          code: "P1001",
          clientVersion: "x",
        }),
    ],
    [
      "a Prisma initialization error",
      () => new Prisma.PrismaClientInitializationError("connection refused", "x"),
    ],
    ["a timeout", () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
    ["an unknown Error", () => new Error("boom")],
    ["a thrown non-Error", () => "weird"],
  ])("%s -> pricing_lookup_failed (transient)", async (_n, err) => {
    const svc = make(async () => {
      throw err();
    });
    await expect(svc.syncStripeSubscriptionPrice("t1")).resolves.toEqual({
      synced: false,
      reason: "pricing_lookup_failed",
    });
  });
});
