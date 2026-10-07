import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * BUG-A / SA-715: ONE helper (replay-same-cart.ts) decides "is this a replay of the SAME request?"
 * at every create() replay exit. A mismatch is the coded 409 carrying the HOLDING order's id (the web
 * navigates to it - it never re-mints and resubmits).
 */
describe("OrdersService.create - an Idempotency-Key replay must be a replay of the same request", () => {
  const dto = (key: string, qty = 1, status?: "DRAFT" | "PENDING") =>
    ({
      customerId: "cust-1",
      items: [{ productId: "p1", qty }],
      idempotencyKey: key,
      ...(status ? { status } : {}),
    }) as never;
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "ord-1",
    customerId: "cust-1",
    status: "PENDING",
    lineItems: [{ productId: "p1", name: "P1", qty: 1, status: "PENDING" }],
    ...over,
  });

  async function build(preCheck: unknown, afterRace?: unknown) {
    const h = await buildOrdersService();
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      deletedAt: null,
      user: { status: "ACTIVE" },
    });
    h.prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", unit: "each" }]);
    const spy = jest.spyOn(h.service, "findReplayCandidateByKey");
    spy.mockResolvedValueOnce(preCheck as never);
    if (afterRace !== undefined) spy.mockResolvedValue(afterRace as never);
    return h;
  }
  const errorOf = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );
  const p2002 = () =>
    Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["tenantId", "idempotencyKey"] },
    });

  it("(a) pre-check: an edited cart under a used key is a CART_MISMATCH 409 carrying the order id", async () => {
    const h = await build(stored());
    const e = await errorOf(h.service.create(dto("ka", 3), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: "ord-1",
    });
  });

  it("(b) the P2002 race exit: an edited body is a 409, never a replay of the winner", async () => {
    const h = await build(null, stored());
    h.prisma.order.create.mockRejectedValue(p2002());
    const e = await errorOf(h.service.create(dto("kb", 3), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: "ord-1",
    });
  });

  it("(b') the P2002 race exit still replays an IDENTICAL body", async () => {
    const h = await build(null, stored());
    h.prisma.order.create.mockRejectedValue(p2002());
    const onReplay = jest.fn();
    const e = await errorOf(
      h.service.create(dto("kb2", 1), operatorPayload as never, { onReplay }),
    );
    expect(e).toBeNull();
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("(d) a Save-as-Draft that timed out, then Create Order on the same key: 409 DRAFT_MISMATCH with the order id", async () => {
    const h = await build(stored({ status: "DRAFT" }));
    const e = await errorOf(h.service.create(dto("kd", 1, "PENDING"), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
      orderId: "ord-1",
    });
  });

  it("(d') and the reverse: a DRAFT save on the key of a real order is refused, not replayed as the draft", async () => {
    const h = await build(stored({ status: "PENDING" }));
    const e = await errorOf(h.service.create(dto("kd2", 1, "DRAFT"), operatorPayload as never));
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
      orderId: "ord-1",
    });
  });

  it("(d'') a DRAFT retried as a DRAFT (same cart) is a plain replay", async () => {
    const h = await build(stored({ status: "DRAFT" }));
    const onReplay = jest.fn();
    const e = await errorOf(
      h.service.create(dto("kd3", 1, "DRAFT"), operatorPayload as never, { onReplay }),
    );
    expect(e).toBeNull();
    expect(onReplay).toHaveBeenCalledTimes(1);
  });
});

describe("isIdempotencyKeyViolation - the pg driver adapter's P2002 shape", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isIdempotencyKeyViolation } = require("./replay-same-cart");
  it("matches the native engine's meta.target", () => {
    expect(
      isIdempotencyKeyViolation({
        code: "P2002",
        meta: { target: ["tenantId", "idempotencyKey"] },
      }),
    ).toBe(true);
  });
  it("matches the driver adapter's constraint index (no meta.target) - the live shape", () => {
    expect(
      isIdempotencyKeyViolation({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: "Order_tenantId_idempotencyKey_key" } },
          },
        },
      }),
    ).toBe(true);
  });
  it("does not match the order-number constraint", () => {
    expect(
      isIdempotencyKeyViolation({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: "Order_tenantId_orderNumber_key" } },
          },
        },
      }),
    ).toBe(false);
    expect(isIdempotencyKeyViolation(new Error("x"))).toBe(false);
  });
});
