/** B1186: isIdempotencyKeyViolation matches the EXACT (tenantId, idempotencyKey) index, in every shape. */
import fixture from "../common/testing/fixtures/p2002-adapter.json";
import { isIdempotencyKeyViolation } from "./replay-same-cart";

const adapter = fixture as unknown as Record<string, any>;
const p2002 = (meta: unknown) => ({ code: "P2002", meta });

describe("isIdempotencyKeyViolation", () => {
  it("true on the captured adapter error for Order_tenantId_idempotencyKey_key", () => {
    expect(isIdempotencyKeyViolation(adapter["Order (tenantId,idempotencyKey)"])).toBe(true);
  });

  it("false on the captured adapter errors of the OTHER Order index and unrelated tables", () => {
    expect(isIdempotencyKeyViolation(adapter["Order (tenantId,orderNumber)"])).toBe(false);
    expect(isIdempotencyKeyViolation(adapter["Tenant.slug (single-col unique)"])).toBe(false);
    expect(isIdempotencyKeyViolation(adapter["Return (tenantId,returnKey)"])).toBe(false);
  });

  it("false on the OrderIdempotencyKey table's indexes (a substring match would say true)", () => {
    for (const index of [
      "OrderIdempotencyKey_tenantId_key_key",
      "OrderIdempotencyKey_orderId_key_key",
    ]) {
      expect(
        isIdempotencyKeyViolation(
          p2002({ driverAdapterError: { cause: { constraint: { index } } } }),
        ),
      ).toBe(false);
      expect(isIdempotencyKeyViolation(p2002({ target: index }))).toBe(false);
    }
    expect(isIdempotencyKeyViolation(p2002({ target: ["tenantId", "key"] }))).toBe(false);
  });

  it("true on both legacy native shapes", () => {
    expect(isIdempotencyKeyViolation(p2002({ target: ["tenantId", "idempotencyKey"] }))).toBe(true);
    expect(isIdempotencyKeyViolation(p2002({ target: "Order_tenantId_idempotencyKey_key" }))).toBe(
      true,
    );
  });

  it("true via the originalMessage's quoted name; false for a non-P2002", () => {
    expect(
      isIdempotencyKeyViolation(
        p2002({
          driverAdapterError: {
            cause: {
              originalMessage:
                'duplicate key value violates unique constraint "Order_tenantId_idempotencyKey_key"',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isIdempotencyKeyViolation({
        code: "P2003",
        meta: { target: "Order_tenantId_idempotencyKey_key" },
      }),
    ).toBe(false);
    expect(isIdempotencyKeyViolation(null)).toBe(false);
  });
});
