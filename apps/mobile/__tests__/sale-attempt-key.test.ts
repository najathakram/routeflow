/**
 * Row 485: the mobile New sale composer sends ONE Idempotency-Key per sale attempt. A retry of the same
 * cart reuses it (an unknown outcome, a network error, a 5xx, an error naming a committed order or invoice);
 * a success, a definitive refusal with no committed sale, or a changed cart gives the next ring a new key.
 */
import * as fs from "fs";
import * as path from "path";
import { SALE_RECOVERY_COPY, saleRecovery } from "@routeflow/types/sale-attempt";
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

  it("a changed cart after a settled attempt is a new attempt with a new key", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(400, { message: "no" }) });
    expect(h.keyFor("cart-B")).not.toBe(first);
  });

  it("while the outcome is unknown the key is held whatever the fingerprint says", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    expect(h.keyFor("cart-B")).toBe(first);
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

describe("the unknown-outcome lock (state machine)", () => {
  it("starts unlocked", () => {
    const h = holder();
    h.keyFor("cart-A");
    expect(h.unknown()).toBeNull();
  });

  it.each([
    ["a 5xx", apiError(500), { invoiceId: null, orderId: null }],
    ["a dropped connection", new Error("Network Error"), { invoiceId: null, orderId: null }],
    [
      "a body naming the order",
      apiError(500, { orderId: "o1" }),
      { invoiceId: null, orderId: "o1" },
    ],
    [
      "a body naming both",
      apiError(400, { invoiceId: "i1", orderId: "o1" }),
      { invoiceId: "i1", orderId: "o1" },
    ],
  ])("%s locks the sale and records what it names", (_n, error, expected) => {
    const h = holder();
    h.keyFor("cart-A");
    h.settle({ ok: false, error });
    expect(h.unknown()).toEqual(expected);
  });

  it("a success or a definitive refusal unlocks", () => {
    const h = holder();
    h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    h.settle({ ok: true });
    expect(h.unknown()).toBeNull();
    h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    h.settle({ ok: false, error: apiError(400, { message: "no" }) });
    expect(h.unknown()).toBeNull();
  });

  it("startNew unlocks, clears the key, and the next ring mints a new one", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    h.startNew();
    expect(h.unknown()).toBeNull();
    expect(h.peek()).toBeNull();
    expect(h.keyFor("cart-A")).not.toBe(first);
  });

  it("Try again (the same fingerprint) keeps the key and the lock until it settles", () => {
    const h = holder();
    const first = h.keyFor("cart-A");
    h.settle({ ok: false, error: apiError(500) });
    expect(h.keyFor("cart-A")).toBe(first);
    expect(h.unknown()).not.toBeNull();
  });
});

describe("saleRecovery and the shared copy", () => {
  it("picks the invoice, else the order, else the recent orders", () => {
    expect(saleRecovery({ invoiceId: "i1", orderId: "o1" })).toEqual({ kind: "invoice", id: "i1" });
    expect(saleRecovery({ invoiceId: null, orderId: "o1" })).toEqual({ kind: "order", id: "o1" });
    expect(saleRecovery({ invoiceId: null, orderId: null })).toEqual({ kind: "recent" });
  });

  it("pins the copy both clients show", () => {
    expect(SALE_RECOVERY_COPY).toEqual({
      title: "Sale not confirmed",
      body: "We couldn't confirm this sale. It may already be recorded, so the cart is locked. Try again to finish it, or open it to check.",
      tryAgain: "Try again",
      openOrder: "Open order",
      openInvoice: "Open invoice",
      recentOrders: "Check recent orders",
      startNew: "Start a new sale",
      confirmTitle: "Start a new sale?",
      confirmBody:
        "Check recent orders first. If this sale was recorded, starting a new one rings it up twice.",
      confirmKeep: "Keep this sale",
    });
  });
});

describe("the composer locks and renders the three actions", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "new.tsx"),
    "utf8",
  );
  const panel = fs.readFileSync(
    path.join(__dirname, "..", "components", "SaleUnknownPanel.tsx"),
    "utf8",
  );

  it("disables editing while unknown: guarded setters, a pointer-blocking wrapper, Create and review off", () => {
    expect(src).toMatch(/if \(!saleLockRef\.current\) setItemsRaw\(u\)/);
    expect(src).toMatch(/if \(!saleLockRef\.current\) setUnlistedRaw\(u\)/);
    expect(src).toMatch(/pointerEvents=\{saleUnknown \? "none" : "auto"\}/);
    expect(src).toMatch(/!saleRecorded && !saleUnknown/);
    expect(src).toMatch(/disabled=\{totalItems === 0 \|\| !!saleUnknown\}/);
  });

  it("settles every outcome into the lock", () => {
    expect(src).toMatch(
      /const unknown = saleKey\.unknown\(\);\s*if \(unknown\) \{\s*saleLockRef\.current = true;/,
    );
    expect(src).toMatch(/saleKey\.settle\(\{ ok: true \}\);\s*saleLockRef\.current = false;/);
  });

  it("renders Try again, the open link and Start a new sale (confirmed, with the recent-orders action)", () => {
    expect(panel).toMatch(/COPY\.tryAgain/);
    expect(panel).toMatch(/COPY\.openInvoice/);
    expect(panel).toMatch(/COPY\.openOrder/);
    expect(panel).toMatch(/COPY\.recentOrders/);
    expect(panel).toMatch(/COPY\.startNew/);
    expect(src).toMatch(
      /chooseAction\(SALE_RECOVERY_COPY\.confirmTitle, SALE_RECOVERY_COPY\.confirmBody/,
    );
    expect(src).toMatch(/label: SALE_RECOVERY_COPY\.recentOrders/);
    expect(src).toMatch(/onPress: startNewSale/);
    expect(src).toMatch(/postSale\(lastSaleRef\.current\)/);
  });
});
