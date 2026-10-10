import { orderOverpayCopy, parseOrderEditWouldOverpay } from "./order-overpay";
import { codedToastCopy } from "./generic-toast-copy";

const RAW = "server text: invoice INV-1 paid 100 exceeds 80";
const body = {
  code: "ORDER_EDIT_WOULD_OVERPAY",
  message: RAW,
  invoiceId: "inv-1",
  paid: 100,
  projectedTotal: 80,
  excess: 20,
};
const e409 = (data: Record<string, unknown> = body) => ({ response: { status: 409, data } });

describe("parseOrderEditWouldOverpay", () => {
  it("reads the structured fields from the 409", () => {
    expect(parseOrderEditWouldOverpay(e409())).toEqual({
      invoiceId: "inv-1",
      paid: 100,
      projectedTotal: 80,
      excess: 20,
    });
  });
  it("is null for other codes, statuses and non-errors", () => {
    expect(parseOrderEditWouldOverpay(e409({ code: "OTHER" }))).toBeNull();
    expect(parseOrderEditWouldOverpay({ response: { status: 400, data: body } })).toBeNull();
    expect(parseOrderEditWouldOverpay(null)).toBeNull();
    expect(parseOrderEditWouldOverpay(new Error("x"))).toBeNull();
  });
  it("tolerates missing numbers (contract-first)", () => {
    expect(parseOrderEditWouldOverpay(e409({ code: "ORDER_EDIT_WOULD_OVERPAY" }))).toEqual({
      invoiceId: null,
      paid: null,
      projectedTotal: null,
      excess: null,
    });
  });
});

describe("orderOverpayCopy", () => {
  it("is fixed copy with the excess from the structured field, never the server text", () => {
    const text = orderOverpayCopy({ invoiceId: "i", paid: 100, projectedTotal: 80, excess: 20 });
    expect(text).toContain("$20.00");
    expect(text).not.toContain("server text");
  });
  it("falls back to numberless copy when the excess is absent", () => {
    const text = orderOverpayCopy({
      invoiceId: null,
      paid: null,
      projectedTotal: null,
      excess: null,
    });
    expect(text).not.toMatch(/\$/);
    expect(text).toMatch(/Record a return/);
  });
  it("is mapped in the central coded-error copy and never shows server text", () => {
    const copy = codedToastCopy(e409());
    expect(copy).toBeTruthy();
    expect(copy).not.toContain("server text");
  });
});
