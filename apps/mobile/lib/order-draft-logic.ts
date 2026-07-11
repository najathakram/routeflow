/**
 * Pure gate for the operator order builder's two save paths, mirroring web's
 * CreateOrderModal footer: a normal submit ("Create Order") needs a customer AND
 * ≥1 item; "Save as Draft" needs only a customer (the API allows a zero-item
 * DRAFT — orders.service `create()` skips the item-count check when
 * `status === "DRAFT"`). Screen-free so __tests__/*.test.ts can lock it.
 */
export interface OrderSubmitGate {
  ok: boolean;
  title?: string;
  message?: string;
}

export function orderSubmitGate(opts: {
  hasCustomer: boolean;
  itemCount: number;
  asDraft: boolean;
}): OrderSubmitGate {
  if (!opts.hasCustomer) {
    return { ok: false, title: "Pick a customer", message: "Choose a customer before saving." };
  }
  if (!opts.asDraft && opts.itemCount === 0) {
    return {
      ok: false,
      title: "Add at least one item",
      message: "Tap + on any product to start the order, or save it as a draft.",
    };
  }
  return { ok: true };
}
