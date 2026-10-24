import { ConflictException } from "@nestjs/common";
import { findOrderIdByIdempotencyKey } from "../orders/merge-idempotency";
import { buyerSubmitHash } from "./buyer-order-idempotency";

/**
 * B1094 replay semantics the buyer submit relies on, against the REAL lookup (fake prisma only).
 *
 * KNOWN: Order-column replay is unverified; clients rotate keys.
 * A key stamped on the Order column (written by create()) carries no cart fingerprint, so a replay
 * through it is acknowledged WITHOUT comparing carts (`verified: false`) — a changed cart under a reused
 * key gets the existing order back, not CART_MISMATCH. Only the OrderIdempotencyKey TABLE (written by
 * a merge fold, with `responseHash`) answers CART_MISMATCH. The web and mobile buyer clients mint a new
 * key whenever the cart changes (buyer-submit-key.ts), so a normal client never reaches this.
 * Follow-up B1115: store a cart fingerprint on the create path (needs a migration). When it lands,
 * flip the "Order-column" case below to expect the coded CART_MISMATCH 409.
 */
describe("buyer replay lookup (findOrderIdByIdempotencyKey)", () => {
  const CUSTOMER = "cust-1";
  const cartA = [{ productId: "p1", qty: 3 }];
  const cartB = [{ productId: "p1", qty: 9 }];

  const deps = (db: { table?: unknown; column?: unknown }) => ({
    logger: { warn: jest.fn() },
    prisma: {
      getTenantId: () => "t-1",
      forTenant: () => ({
        orderIdempotencyKey: { findFirst: jest.fn().mockResolvedValue(db.table ?? null) },
        order: { findFirst: jest.fn().mockResolvedValue(db.column ?? null) },
      }),
    },
  });

  it("KNOWN: Order-column replay is unverified; clients rotate keys (a different cart is replayed, not refused)", async () => {
    // B1115 follow-up: flips to a CART_MISMATCH rejection once the create path stores a fingerprint.
    const hit = await findOrderIdByIdempotencyKey(
      deps({ column: { id: "ord-1" } }),
      "key-1",
      CUSTOMER,
      buyerSubmitHash(CUSTOMER, cartB),
    );
    expect(hit).toEqual({ orderId: "ord-1", verified: false });
  });

  it("the key TABLE verifies: the same cart is a verified replay", async () => {
    const hit = await findOrderIdByIdempotencyKey(
      deps({ table: { orderId: "ord-1", responseHash: buyerSubmitHash(CUSTOMER, cartA) } }),
      "key-1",
      CUSTOMER,
      buyerSubmitHash(CUSTOMER, cartA),
    );
    expect(hit).toEqual({ orderId: "ord-1", verified: true });
  });

  it("the key TABLE with a DIFFERENT cart is the coded CART_MISMATCH 409 naming the buyer's own order", async () => {
    const err: any = await findOrderIdByIdempotencyKey(
      deps({ table: { orderId: "ord-1", responseHash: buyerSubmitHash(CUSTOMER, cartA) } }),
      "key-1",
      CUSTOMER,
      buyerSubmitHash(CUSTOMER, cartB),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      reason: "CART_MISMATCH",
      orderId: "ord-1",
    });
  });
});
