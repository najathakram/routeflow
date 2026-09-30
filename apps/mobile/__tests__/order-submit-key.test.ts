/**
 * B215/R3 — PER-CUSTOMER order submit keys (`lib/order-submit-key.ts`).
 *
 * Round 1 rotated ONE module-level key whenever the operator switched customer. That fixed the
 * cross-customer 409 but broke the A -> B -> A round trip: coming back to A handed A's still-live
 * cart a BRAND NEW key, so a timed-out-but-committed submit for A could no longer be collapsed by
 * the server and landed as a sibling duplicate order — exactly the B196 leg the key exists to
 * close. Keys are now held per customer, matching the server's customer-scoped replay identity
 * (`findOrderIdByIdempotencyKey` scopes every lookup to `customerId`).
 *
 * Pure logic, no RN/Expo — runs under the mobile jest config's `__tests__/**\/*.test.ts` match.
 */
import {
  clearAllOrderSubmitKeys,
  getOrderSubmitKey,
  resetOrderSubmitKey,
} from "../lib/order-submit-key";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("order-submit-key — one key per customer (B215/R3)", () => {
  beforeEach(() => clearAllOrderSubmitKeys());

  it("returns the SAME key for the same customer across every retry of that cart", () => {
    const first = getOrderSubmitKey("cust-a");
    expect(getOrderSubmitKey("cust-a")).toBe(first);
    expect(first).toMatch(UUID_V4);
  });

  it("mints a DIFFERENT key for a different customer", () => {
    const a = getOrderSubmitKey("cust-a");
    const b = getOrderSubmitKey("cust-b");
    expect(b).not.toBe(a);
    expect(b).toMatch(UUID_V4);
  });

  it("reset(A) leaves B's key untouched", () => {
    const a = getOrderSubmitKey("cust-a");
    const b = getOrderSubmitKey("cust-b");
    resetOrderSubmitKey("cust-a");
    expect(getOrderSubmitKey("cust-a")).not.toBe(a);
    expect(getOrderSubmitKey("cust-b")).toBe(b);
  });

  it("A -> B -> A returns A's ORIGINAL key (the round-1 rotation bug)", () => {
    const a = getOrderSubmitKey("cust-a");
    getOrderSubmitKey("cust-b");
    expect(getOrderSubmitKey("cust-a")).toBe(a);
  });

  it("clearAllOrderSubmitKeys drops every customer's key", () => {
    const a = getOrderSubmitKey("cust-a");
    const b = getOrderSubmitKey("cust-b");
    clearAllOrderSubmitKeys();
    expect(getOrderSubmitKey("cust-a")).not.toBe(a);
    expect(getOrderSubmitKey("cust-b")).not.toBe(b);
  });

  it("a null/undefined customer shares one `__none__` slot, distinct from any real customer", () => {
    const none = getOrderSubmitKey(null);
    expect(getOrderSubmitKey(undefined)).toBe(none);
    expect(getOrderSubmitKey("cust-a")).not.toBe(none);
    resetOrderSubmitKey(null);
    expect(getOrderSubmitKey(undefined)).not.toBe(none);
  });
});
