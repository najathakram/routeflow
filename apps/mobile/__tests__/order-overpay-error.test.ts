import {
  orderOverpayCopy,
  orderOverpayReturnRoute,
  parseOrderEditWouldOverpay,
} from "../lib/order-overpay-error";

const body = {
  code: "ORDER_EDIT_WOULD_OVERPAY",
  message: "server text: leak",
  invoiceId: "inv-1",
  paid: 100,
  projectedTotal: 80,
  excess: 20,
};
const e409 = (data: Record<string, unknown> = body) => ({ response: { status: 409, data } });

describe("parseOrderEditWouldOverpay", () => {
  it("reads the structured fields", () => {
    expect(parseOrderEditWouldOverpay(e409())).toEqual({
      invoiceId: "inv-1",
      paid: 100,
      projectedTotal: 80,
      excess: 20,
    });
  });
  it("is null for other codes / statuses / non-errors", () => {
    expect(parseOrderEditWouldOverpay(e409({ code: "X" }))).toBeNull();
    expect(parseOrderEditWouldOverpay({ response: { status: 400, data: body } })).toBeNull();
    expect(parseOrderEditWouldOverpay(undefined)).toBeNull();
  });
  it("tolerates missing numbers", () => {
    expect(parseOrderEditWouldOverpay(e409({ code: "ORDER_EDIT_WOULD_OVERPAY" }))).toEqual({
      invoiceId: null,
      paid: null,
      projectedTotal: null,
      excess: null,
    });
  });
});

describe("orderOverpayCopy", () => {
  it("is fixed copy with the structured excess, never the server text", () => {
    const t = orderOverpayCopy({ invoiceId: "i", paid: 100, projectedTotal: 80, excess: 20 });
    expect(t).toContain("$20.00");
    expect(t).not.toContain("leak");
  });
  it("has numberless copy when the excess is absent", () => {
    const t = orderOverpayCopy({ invoiceId: null, paid: null, projectedTotal: null, excess: null });
    expect(t).not.toContain("$");
  });
});

describe("orderOverpayReturnRoute", () => {
  it("deep-links to the operator inline return for this order", () => {
    expect(orderOverpayReturnRoute({ id: "o1", customerId: "c1", customerName: "Acme" })).toEqual({
      pathname: "/(operator)/returns/inline",
      params: { customerId: "c1", orderId: "o1", customerName: "Acme" },
    });
  });
  it("is null when the customer is unknown", () => {
    expect(orderOverpayReturnRoute({ id: "o1" })).toBeNull();
  });
});
