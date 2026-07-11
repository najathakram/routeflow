/**
 * Locks the operator order-builder save gate: normal submit needs customer + ≥1
 * item; "Save as draft" needs only a customer (zero-item DRAFT allowed).
 */
import { orderSubmitGate } from "../lib/order-draft-logic";

describe("orderSubmitGate", () => {
  it("blocks both paths without a customer", () => {
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 0, asDraft: false }).ok).toBe(false);
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 3, asDraft: true }).ok).toBe(false);
  });

  it("blocks a normal submit with zero items", () => {
    const g = orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: false });
    expect(g.ok).toBe(false);
    expect(g.title).toBe("Add at least one item");
  });

  it("allows a zero-item DRAFT once a customer is chosen", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: true })).toEqual({
      ok: true,
    });
  });

  it("allows a normal submit with a customer and items", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 2, asDraft: false })).toEqual({
      ok: true,
    });
  });
});
