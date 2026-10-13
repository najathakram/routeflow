/**
 * Row 485: the mobile New sale composer sends ONE Idempotency-Key per sale attempt. A retry of the same
 * cart reuses it (an unknown outcome, a network error, a 5xx, an error naming a committed order or invoice);
 * a success, a definitive refusal with no committed sale, or a changed cart gives the next ring a new key.
 */
import * as fs from "fs";
import * as path from "path";
import { createSaleAttemptKey, isDefinitiveSaleRefusal } from "../lib/sale-attempt-key";

const apiError = (status: number, data: Record<string, unknown> = {}) => ({
  response: { status, data },
});
let n = 0;
const holder = () => createSaleAttemptKey(() => `key-${++n}`);

describe("isDefinitiveSaleRefusal (the one shared rule)", () => {
  it.each([400, 401, 403, 404, 409, 422, 429])("a %s with no committed sale is definitive", (s) => {
    expect(isDefinitiveSaleRefusal(apiError(s, { message: "no" }))).toBe(true);
  });

  it.each([
    ["a 500", apiError(500)],
    ["a 502", apiError(502)],
    ["a 408", apiError(408)],
    ["a dropped connection", new Error("Network Error")],
    ["a 400 naming the committed invoice", apiError(400, { invoiceId: "i1" })],
    ["a 500 naming the committed order", apiError(500, { orderId: "o1" })],
    ["a 409 order-exists code", apiError(409, { code: "IDEMPOTENCY_KEY_CART_MISMATCH" })],
    ["a 409 closed-day code", apiError(409, { code: "COUNTER_SALE_DAY_CLOSED" })],
    ["undefined", undefined],
  ])("%s is NOT definitive", (_n, err) => {
    expect(isDefinitiveSaleRefusal(err)).toBe(false);
  });
});

describe("createSaleAttemptKey", () => {
  it("mints a key on the first ring", () => {
    const h = holder();
    expect(h.keyFor("cart-A")).toMatch(/^key-\d+$/);
  });

  it.each([
    ["a 5xx", { ok: false as const, error: apiError(500) }],
    ["a dropped connection", { ok: false as const, error: new Error("Network Error") }],
    [
      "an error naming a committed order",
      { ok: false as const, error: apiError(500, { orderId: "o1" }) },
    ],
    [
      "an error naming a committed invoice",
      { ok: false as const, error: apiError(400, { invoiceId: "i1" }) },
    ],
  ])("the same cart retried after %s sends the SAME key", (_n, outcome) => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle(outcome);
    expect(h.keyFor("cart-A")).toBe(first);
    h.settle(outcome);
    expect(h.keyFor("cart-A")).toBe(first);
  });

  it("a success clears it: the next sale gets a NEW key", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: true });
    expect(h.peek()).toBeNull();
    expect(h.keyFor("cart-A")).not.toBe(first);
  });

  it("a definitive refusal that names no committed sale clears it", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(400, { message: "Customer not found" }) });
    expect(h.peek()).toBeNull();
    expect(h.keyFor("cart-A")).not.toBe(first);
  });

  it("a changed cart is a new attempt with a new key", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    expect(h.keyFor("cart-B")).not.toBe(first);
  });

  it("settle with nothing held is a no-op", () => {
    const h = holder();
    expect(() => h.settle({ ok: true })).not.toThrow();
    expect(h.peek()).toBeNull();
  });
});

describe("the invoice composer's sale path uses it", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "new.tsx"),
    "utf8",
  );
  const api = fs.readFileSync(path.join(__dirname, "..", "lib", "api", "orders.ts"), "utf8");

  it("mints the key from the cart, sends it, and settles on both outcomes", () => {
    expect(src).toMatch(/useState\(createSaleAttemptKey\)/);
    expect(src).toMatch(/saleKey\.keyFor\(JSON\.stringify\(saleDto\)\)/);
    expect(src).toMatch(/createSaleMut\.mutate\(\s*\{ \.\.\.saleDto, idempotencyKey \}/);
    expect(src).toMatch(/saleKey\.settle\(\{ ok: true \}\)/);
    expect(src).toMatch(/saleKey\.settle\(\{ ok: false, error: err \}\)/);
  });

  it("useCreateSale sends it as the idempotency-key header, not in the body", () => {
    expect(api).toMatch(
      /"\/orders\/sell",\s*dto,\s*idempotencyKey \? \{ headers: \{ "idempotency-key": idempotencyKey \} \}/,
    );
  });
});
