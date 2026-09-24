import { HttpStatus } from "@nestjs/common";
import { BillingWebhookController } from "./billing-webhook.controller";

// B593 review F1: a handler failure must not masquerade as a signature failure.
function build(opts: { construct?: () => unknown; handle?: () => Promise<void> } = {}) {
  const stripe = {
    isConfigured: true,
    constructWebhookEvent: jest.fn(
      opts.construct ?? (() => ({ type: "checkout.session.completed", id: "evt_1" })),
    ),
  };
  const billing = { handleWebhookEvent: jest.fn(opts.handle ?? (async () => undefined)) };
  const controller = new BillingWebhookController(stripe as never, billing as never);
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const req = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
  return { controller, stripe, billing, res, json, req };
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
