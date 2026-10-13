/**
 * Row 466 (sale path): createSale commits the ORDER, then builds its invoice. A failure of that
 * step carries `orderId`; the composer opens the order (or the invoice, when the body has one)
 * instead of reporting a plain failure, which a retry would turn into a duplicate sale.
 */
import * as fs from "fs";
import * as path from "path";
import { KEPT_ORDER_COPY, keptOrderId } from "../lib/kept-draft-invoice";

const apiError = (data: unknown) => ({ response: { status: 500, data } });

describe("keptOrderId", () => {
  it.each([
    ["the coded 500", { code: "SALE_INVOICE_CREATE_FAILED", orderId: "ord-1" }],
    ["a plain 400 with a raw message", { statusCode: 400, message: "RAW", orderId: "ord-1" }],
    ["both ids (the screen prefers the invoice)", { invoiceId: "inv-1", orderId: "ord-1" }],
  ])("%s -> the order id", (_n, data) => {
    expect(keptOrderId(apiError(data))).toBe("ord-1");
  });

  it("is null with no orderId, an empty or non-string one, a network error, undefined and null", () => {
    expect(keptOrderId(apiError({ message: "Customer not found" }))).toBeNull();
    expect(keptOrderId(apiError({ orderId: "" }))).toBeNull();
    expect(keptOrderId(apiError({ orderId: 7 }))).toBeNull();
    expect(keptOrderId(new Error("Network Error"))).toBeNull();
    expect(keptOrderId(undefined)).toBeNull();
    expect(keptOrderId(null)).toBeNull();
  });

  it("the screen copy is fixed and carries no server text", () => {
    expect(KEPT_ORDER_COPY).toMatch(/order/);
    expect(KEPT_ORDER_COPY).not.toMatch(/RAW/);
  });
});

describe("the invoice composer's sale path", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "new.tsx"),
    "utf8",
  );

  it("opens the kept invoice first, then the kept order, before any other error branch", () => {
    const at = src.indexOf(`onUnitNotOffered("Couldn't record the sale")`);
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 420), at);
    expect(before).toMatch(
      /onKeptDraft\(keptId\)[\s\S]*keptOrderId\(err\)[\s\S]*onKeptOrder\(keptOrder\)/,
    );
  });

  it("onKeptOrder routes to the operator order screen", () => {
    expect(src).toMatch(/router\.replace\(`\/\(operator\)\/orders\/\$\{orderId\}`/);
  });
});
