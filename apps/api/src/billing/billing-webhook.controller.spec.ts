import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BillingWebhookController } from "./billing-webhook.controller";

// B593 review F1: a handler failure must not masquerade as a signature failure.
function build(
  opts: {
    construct?: () => unknown;
    handle?: () => Promise<void>;
    /** #2442: the ledger insert (default: a first delivery). */
    create?: () => Promise<unknown>;
    /** #2442: the already-ledgered row a duplicate insert finds. */
    existing?: { outcome: string | null } | null;
    /** #2476: rows the redelivery claim (one updateMany) takes — 1 = claimed. */
    claimed?: number;
  } = {},
) {
  const stripe = {
    isConfigured: true,
    constructWebhookEvent: jest.fn(
      opts.construct ?? (() => ({ type: "checkout.session.completed", id: "evt_1" })),
    ),
  };
  const billing = { handleWebhookEvent: jest.fn(opts.handle ?? (async () => undefined)) };
  const prisma = {
    stripeBillingEvent: {
      create: jest.fn(opts.create ?? (async () => ({}))),
      findUnique: jest.fn(async () => opts.existing ?? null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: opts.claimed ?? 1 })),
    },
  };
  const controller = new BillingWebhookController(
    stripe as never,
    billing as never,
    prisma as never,
  );
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const req = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
  return { controller, stripe, billing, prisma, res, json, req };
}

describe("BillingWebhookController — signature vs handler failures", () => {
  it("a good event is handled and acknowledged with 200", async () => {
    const { controller, billing, res, json, req } = build();

    await controller.handleWebhook(req as never, res as never);

    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it("a bad signature is a 400 and the handler is never invoked", async () => {
    const { controller, billing, res, json, req } = build({
      construct: () => {
        throw new Error("No signatures found matching the expected signature");
      },
    });

    await controller.handleWebhook(req as never, res as never);

    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({ error: "Webhook signature verification failed" });
  });

  it("a HANDLER failure is a 500 (Stripe redelivers), never the 'signature verification failed' 400", async () => {
    const { controller, res, json, req } = build({
      handle: async () => {
        throw new Error("Transaction already closed");
      },
    });

    await controller.handleWebhook(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.status).not.toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({ error: "Webhook handler failed" });
  });
});

// #2442: the billing webhook mirrors the Connect webhook — Stripe, not a browser, is the caller
// (@SkipThrottle), and an insert-first event ledger makes a redelivery of a COMPLETED event a no-op
// (closing #2440's residual: a redelivered invoice.payment_failed incremented failedPaymentCount
// twice). A delivery whose first attempt errored or never finished is re-run — that is the retry
// our own 500 asked for.
describe("#2442 BillingWebhookController — throttle skip and event-id ledger", () => {
  const dup = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const failedEvt = () => ({
    type: "invoice.payment_failed",
    id: "evt_pf",
    created: 1_700_000_000,
  });

  it("is exempt from the per-IP throttler", () => {
    expect(Reflect.getMetadata("THROTTLER:SKIPdefault", BillingWebhookController)).toBe(true);
  });

  it("ledgers the event id BEFORE the handler runs", async () => {
    const { controller, billing, prisma, req, res } = build({ construct: failedEvt });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.create).toHaveBeenCalledWith({
      data: {
        id: "evt_pf",
        type: "invoice.payment_failed",
        createdAt: new Date(1_700_000_000_000),
      },
    });
    expect(prisma.stripeBillingEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      billing.handleWebhookEvent.mock.invocationCallOrder[0],
    );
  });

  it("a redelivered, already-COMPLETED invoice.payment_failed is a no-op (200, handler not run)", async () => {
    const { controller, billing, res, json, req } = build({
      construct: failedEvt,
      create: async () => {
        throw dup();
      },
      existing: { outcome: "processed" },
      claimed: 0, // #2476: a completed row is never claimable
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it.each([
    ["an error outcome", { outcome: "error:boom" }],
    ["no outcome (the first attempt never finished)", { outcome: null }],
  ])("a redelivery after %s is re-run", async (_label, existing) => {
    const { controller, billing, res, req } = build({
      construct: failedEvt,
      create: async () => {
        throw dup();
      },
      existing,
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("a ledger insert failure (not a duplicate) is a 500 and the handler never runs", async () => {
    const { controller, billing, res, req } = build({
      create: async () => {
        throw new Error("connection reset");
      },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("records outcome 'processed' on success", async () => {
    const { controller, prisma, req, res } = build({ construct: failedEvt });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.update).toHaveBeenCalledWith({
      where: { id: "evt_pf" },
      data: { outcome: "processed" },
    });
  });

  it("records an 'error:' outcome on a handler failure, so Stripe's redelivery re-runs it", async () => {
    const { controller, prisma, req, res } = build({
      construct: failedEvt,
      handle: async () => {
        throw new Error("db down");
      },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.update).toHaveBeenCalledWith({
      where: { id: "evt_pf" },
      data: { outcome: "error:db down" },
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("a failed outcome write never changes the response already sent", async () => {
    const { controller, prisma, res, req } = build({ construct: failedEvt });
    prisma.stripeBillingEvent.update.mockRejectedValue(new Error("db blip"));
    await expect(controller.handleWebhook(req as never, res as never)).resolves.toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });
});

// #2476 / SA-472: a redelivery (P2002) claims the ledger row EXCLUSIVELY with one updateMany — an
// "error:" row at once, a NULL (in-flight) row only once its lease (5 min, processedAt) has expired.
// Count 0 ⇒ re-read: completed ⇒ 200 duplicate; still in flight elsewhere ⇒ 503 (a 2xx would ack an
// event another worker may still fail). The outcome write in finally is LOGGED on failure.
describe("#2476 BillingWebhookController — exclusive claim on redelivery (SA-472)", () => {
  const LEASE_MS = 5 * 60 * 1000;
  const dup = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const evt = () => ({ type: "invoice.payment_failed", id: "evt_pf", created: 1_700_000_000 });

  it("claims with ONE updateMany: an error: row, or a NULL row older than the 5-minute lease", async () => {
    const { controller, prisma, req, res } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
    });
    const before = Date.now();
    await controller.handleWebhook(req as never, res as never);
    const arg = (prisma.stripeBillingEvent.updateMany.mock.calls as any[])[0][0];
    expect(arg.where.id).toBe("evt_pf");
    expect(arg.where.OR).toEqual([
      { outcome: { startsWith: "error:" } },
      { outcome: null, processedAt: { lt: expect.any(Date) } },
    ]);
    const cutoff = arg.where.OR[1].processedAt.lt.getTime();
    expect(cutoff).toBeLessThanOrEqual(Date.now() - LEASE_MS + 5);
    expect(cutoff).toBeGreaterThanOrEqual(before - LEASE_MS - 5);
    expect(arg.data).toEqual({ processedAt: expect.any(Date), outcome: null });
  });

  it("claimed (count 1) ⇒ the handler runs", async () => {
    const { controller, billing, req, res } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 1,
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("not claimed and completed ⇒ 200 duplicate, handler not run", async () => {
    const { controller, billing, req, res, json } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 0,
      existing: { outcome: "processed" },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it("not claimed and still in flight elsewhere (NULL inside the lease) ⇒ 503, handler not run", async () => {
    const { controller, billing, req, res, json } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 0,
      existing: { outcome: null },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith({ error: "Webhook event in progress" });
  });

  it("an outcome-write failure is LOGGED (never swallowed) and never changes the response", async () => {
    const { controller, prisma, req, res } = build({ construct: evt });
    prisma.stripeBillingEvent.update.mockRejectedValue(new Error("db blip"));
    const err = jest.spyOn((controller as any).logger, "error").mockImplementation(() => undefined);
    await controller.handleWebhook(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(err.mock.calls.some((c: any[]) => /outcome/i.test(String(c[0])))).toBe(true);
  });
});
