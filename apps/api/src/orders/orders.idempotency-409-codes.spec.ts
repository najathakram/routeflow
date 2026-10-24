import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * create()'s two Idempotency-Key 409s each carry a code: in BOTH cases the order already exists, so for a
 * counter sale they are an UNKNOWN outcome (the clerk must not ring it again on a new key). The message text
 * is unchanged: existing callers (and the web/mobile toasts that print it) read the same words.
 */
describe("OrdersService.create — Idempotency-Key 409s are coded, messages unchanged", () => {
  const dto = (key: string, qty = 1) =>
    ({ customerId: "cust-1", items: [{ productId: "p1", qty }], idempotencyKey: key }) as never;

  async function build(existing: Record<string, unknown>) {
    const h = await buildOrdersService();
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      deletedAt: null,
      user: { status: "ACTIVE" },
    });
    h.prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", unit: "each" }]);
    jest.spyOn(h.service, "findReplayCandidateByKey").mockResolvedValue(existing as never);
    return h;
  }
  const errorOf = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );

  it("a key held by ANOTHER customer's order: IDEMPOTENCY_KEY_OTHER_ORDER, same message", async () => {
    const h = await build({ id: "ord-9", customerId: "someone-else", lineItems: [] });
    const e = await errorOf(h.service.create(dto("k1"), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toEqual({
      code: "IDEMPOTENCY_KEY_OTHER_ORDER",
      message: "Idempotency-Key already used for a different order",
    });
    expect(e.message).toBe("Idempotency-Key already used for a different order");
  });

  it("the same key with a DIFFERENT cart: IDEMPOTENCY_KEY_CART_MISMATCH, same message", async () => {
    const h = await build({
      id: "ord-1",
      customerId: "cust-1",
      lineItems: [{ productId: "p1", name: "P1", qty: 1, status: "PENDING" }],
    });
    const e = await errorOf(h.service.create(dto("k2", 3), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: "IDEMPOTENCY_KEY_CART_MISMATCH" });
    expect(e.message).toBe(
      "Idempotency-Key reused with a different cart — submit the edited cart as a new order (new key), or retry the original unchanged",
    );
    expect(e.message).toMatch(/reused with a different cart/);
  });

  it("the P2002 race path (the key won by another customer's order after the pre-check) is coded too", async () => {
    const h = await build({ id: "x", customerId: "someone-else", lineItems: [] });
    // pre-check sees nothing; the insert then loses the unique race, and the re-read finds a stranger's order
    (h.service.findReplayCandidateByKey as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "ord-9", customerId: "someone-else", lineItems: [] });
    h.prisma.order.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["tenantId", "idempotencyKey"] },
      }),
    );
    const e = await errorOf(h.service.create(dto("k3"), operatorPayload as never));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_OTHER_ORDER",
      message: "Idempotency-Key already used for a different order",
    });
  });
});
