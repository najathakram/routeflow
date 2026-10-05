import {
  AUTO_PRINT_KEY,
  cartTotals,
  changeDue,
  COUNTER_OUTCOME_UNKNOWN_COPY,
  counterSaleErrorCopy,
  isDefinitiveCounterSaleRefusal,
  counterSaleGate,
  paymentMethodOptions,
  parseScanField,
  preselectFulfilment,
  quickTenderOptions,
  readAutoPrint,
  validatePayment,
  writeAutoPrint,
} from "./counter-sale";

describe("counterSaleGate: reads capabilities.fulfilment only (SA-650)", () => {
  it("always: the button AND New order opens as the counter sale", () => {
    expect(counterSaleGate({ counter: "always", methods: ["PICKUP"] })).toEqual({
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: false,
    });
  });
  it("always + SHIP in methods: 'Ship this order instead' is offered", () => {
    expect(counterSaleGate({ counter: "always", methods: ["PICKUP", "SHIP"] })).toMatchObject({
      opensAsCounter: true,
      offerShipInstead: true,
    });
  });
  it("optional: the button only; never opens as the counter, never offers the ship switch", () => {
    expect(counterSaleGate({ counter: "optional", methods: ["SHIP"] })).toEqual({
      showButton: true,
      opensAsCounter: false,
      offerShipInstead: false,
    });
  });
  it("off, missing or still loading: nothing", () => {
    const none = { showButton: false, opensAsCounter: false, offerShipInstead: false };
    expect(counterSaleGate({ counter: "off" })).toEqual(none);
    expect(counterSaleGate(undefined)).toEqual(none);
    expect(counterSaleGate(null)).toEqual(none);
    expect(counterSaleGate({ counter: "bogus" as never })).toEqual(none);
  });
});

describe("preselectFulfilment: the customer's own path first, then the staff default (SA rule)", () => {
  it("a SHIP-default customer stays SHIP even when the staff default is PICKUP", () => {
    expect(preselectFulfilment("SHIP", "PICKUP")).toBe("SHIP");
  });
  it("no customer path: the staff default", () => {
    expect(preselectFulfilment(null, "PICKUP")).toBe("PICKUP");
    expect(preselectFulfilment(undefined, "SHIP")).toBe("SHIP");
  });
  it("neither: null", () => {
    expect(preselectFulfilment(null, undefined)).toBeNull();
  });
});

describe("cartTotals: money only through @routeflow/pricing", () => {
  it("a loose line is price x qty, cents rounded once", () => {
    expect(cartTotals([{ unitPrice: 1.005, qty: 3 }], 0)).toEqual({
      subtotal: 3.02,
      tax: 0,
      total: 3.02,
    });
  });
  it("a boxed product with boxes + pieces prices the box, prorating the pieces (never qty x unitPrice)", () => {
    const t = cartTotals([{ unitPrice: 120, qty: 0, boxes: 1, pieces: 6, unitsPerBox: 12 }], 0);
    expect(t.subtotal).toBe(180);
  });
  it("tax is one roundMoney of the subtotal, total = subtotal + tax", () => {
    expect(cartTotals([{ unitPrice: 10, qty: 3 }], 0.0825)).toEqual({
      subtotal: 30,
      tax: 2.48,
      total: 32.48,
    });
  });
  it("empty cart is zero", () => {
    expect(cartTotals([], 0.1)).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe("tender: quick buttons and change", () => {
  it("Exact / $20 / $50 / $100, the ones under the total disabled", () => {
    expect(quickTenderOptions(32.48)).toEqual([
      { label: "Exact", amount: 32.48, disabled: false },
      { label: "$20", amount: 20, disabled: true },
      { label: "$50", amount: 50, disabled: false },
      { label: "$100", amount: 100, disabled: false },
    ]);
  });
  it("change is the tender minus the total in cents, never negative", () => {
    expect(changeDue(32.48, 50)).toBe(17.52);
    expect(changeDue(0.1 + 0.2, 1)).toBe(0.7);
    expect(changeDue(10, 5)).toBe(0);
  });
});

describe("payment method chips", () => {
  it("On account is disabled for a walk-in, enabled for a customer", () => {
    const walk = paymentMethodOptions(true);
    expect(walk.map((m) => m.method)).toEqual(["CASH", "CARD", "CHECK", "ON_ACCOUNT"]);
    expect(walk.find((m) => m.method === "ON_ACCOUNT")?.disabled).toBe(true);
    expect(paymentMethodOptions(false).every((m) => !m.disabled)).toBe(true);
  });
  it("validatePayment: cash must cover the total, a check needs a number, walk-in cannot go on account", () => {
    expect(validatePayment({ method: "CASH", total: 10, tendered: 5, isWalkIn: true })).toBe(
      "TENDER_SHORT",
    );
    expect(validatePayment({ method: "CASH", total: 10, tendered: 10, isWalkIn: true })).toBeNull();
    expect(validatePayment({ method: "CHECK", total: 10, reference: " ", isWalkIn: true })).toBe(
      "CHECK_NUMBER_REQUIRED",
    );
    expect(
      validatePayment({ method: "CHECK", total: 10, reference: "1042", isWalkIn: true }),
    ).toBeNull();
    expect(validatePayment({ method: "ON_ACCOUNT", total: 10, isWalkIn: true })).toBe(
      "WALK_IN_NO_ACCOUNT",
    );
    expect(validatePayment({ method: "ON_ACCOUNT", total: 10, isWalkIn: false })).toBeNull();
    expect(validatePayment({ method: "CARD", total: 10, isWalkIn: true })).toBeNull();
  });
});

describe("parseScanField: type a quantity, then scan, to multiply", () => {
  it("1-3 digits are a quantity", () => {
    expect(parseScanField("3")).toEqual({ kind: "qty", qty: 3 });
    expect(parseScanField(" 12 ")).toEqual({ kind: "qty", qty: 12 });
    expect(parseScanField("999")).toEqual({ kind: "qty", qty: 999 });
  });
  it("anything else is a code (a barcode, a SKU, a search)", () => {
    expect(parseScanField("012345678905")).toEqual({ kind: "code", code: "012345678905" });
    expect(parseScanField("SKU-7")).toEqual({ kind: "code", code: "SKU-7" });
    expect(parseScanField("0")).toEqual({ kind: "code", code: "0" });
  });
});

describe("counterSaleErrorCopy: FIXED copy, never the server message", () => {
  it("maps by status/code and ignores response.data.message", () => {
    const e = (status: number, code?: string) => ({
      response: { status, data: { code, message: "RAW SERVER TEXT" } },
    });
    for (const err of [e(400), e(403), e(409), e(422), e(500), {}, null]) {
      const copy = counterSaleErrorCopy(err);
      expect(copy.length).toBeGreaterThan(10);
      expect(copy).not.toMatch(/RAW SERVER TEXT/);
    }
    expect(counterSaleErrorCopy(e(403))).not.toBe(counterSaleErrorCopy(e(500)));
  });
  it("a 403 COUNTER_SALES_DISABLED shows the fixed disabled copy, not the generic permission copy", () => {
    const disabled = counterSaleErrorCopy({
      response: { status: 403, data: { code: "COUNTER_SALES_DISABLED", message: "RAW" } },
    });
    expect(disabled).toBe("Counter sales are not turned on for this business.");
    expect(disabled).not.toBe(counterSaleErrorCopy({ response: { status: 403 } }));
  });
});

describe("counterSaleErrorCopy: an UNKNOWN outcome never claims nothing was charged", () => {
  const unknown = [
    ["a 500", { response: { status: 500, data: { message: "RAW" } } }],
    ["a 503", { response: { status: 503 } }],
    ["a network error (no response)", new Error("Network Error")],
    ["a timeout", { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" }],
    ["an empty error", {}],
    ["null", null],
  ] as const;
  it.each(unknown)("%s: the exact could-not-confirm copy", (_l, err) => {
    expect(counterSaleErrorCopy(err)).toBe(COUNTER_OUTCOME_UNKNOWN_COPY);
    expect(COUNTER_OUTCOME_UNKNOWN_COPY).toBe(
      "We couldn't confirm the sale. Check recent sales before trying again.",
    );
    expect(isDefinitiveCounterSaleRefusal(err)).toBe(false);
  });
  it("'Nothing was charged' appears only for a 409 refusal", () => {
    for (const status of [400, 403, 404, 409, 422, 500, 503]) {
      const copy = counterSaleErrorCopy({ response: { status } });
      expect(/nothing was charged/i.test(copy)).toBe(status === 409);
    }
    expect(/nothing was charged/i.test(counterSaleErrorCopy(new Error("Network Error")))).toBe(
      false,
    );
  });
  it("only 400 / 403 / 404 / 409 / 422 prove nothing was written", () => {
    for (const status of [400, 403, 404, 409, 422])
      expect(isDefinitiveCounterSaleRefusal({ response: { status } })).toBe(true);
    for (const status of [401, 408, 429, 500, 502, 503, 504])
      expect(isDefinitiveCounterSaleRefusal({ response: { status } })).toBe(false);
  });
});

describe("auto-print preference: per device, local, never throws", () => {
  const realLS = Object.getOwnPropertyDescriptor(window, "localStorage");
  afterEach(() => {
    if (realLS) Object.defineProperty(window, "localStorage", realLS);
    window.localStorage.clear();
  });
  it("defaults off; round-trips on and off", () => {
    expect(readAutoPrint()).toBe(false);
    writeAutoPrint(true);
    expect(window.localStorage.getItem(AUTO_PRINT_KEY)).toBe("1");
    expect(readAutoPrint()).toBe(true);
    writeAutoPrint(false);
    expect(readAutoPrint()).toBe(false);
  });
  it("storage unavailable: reads off and writes without crashing", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    expect(readAutoPrint()).toBe(false);
    expect(() => writeAutoPrint(true)).not.toThrow();
  });
});
