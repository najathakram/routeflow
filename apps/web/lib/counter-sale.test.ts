import type { FulfilmentCapability } from "@routeflow/types";
import {
  AUTO_PRINT_KEY,
  cartTotals,
  changeDue,
  COUNTER_OUTCOME_UNKNOWN_COPY,
  counterSaleErrorCopy,
  COUNTER_SALE_CHANGED_COPY,
  COUNTER_SALE_VOIDED_COPY,
  finalCounterSaleCopy,
  isCounterSaleChanged,
  isCounterSaleIncomplete,
  isCounterSaleVoided,
  isCounterSaleNotFound,
  isDefinitiveCounterSaleRefusal,
  counterSaleGate,
  PAYMENT_PROBLEM_COPY,
  paymentMethodOptions,
  PICKUP_NOT_READY_COPY,
  PICKUP_ONLY_COPY,
  PICKUP_KEY_CONFLICT_COPY,
  PICKUP_INVOICE_MISSING_COPY,
  PICKUP_WALK_IN_CREDIT_COPY,
  PICKUP_TENDER_SHORT_COPY,
  PICKUP_PAYMENT_REQUIRED_COPY,
  pickupBalanceDue,
  pickupCompleteErrorCopy,
  parseScanField,
  preselectFulfilment,
  quickTenderOptions,
  readAutoPrint,
  heldAttemptKey,
  readHeldAttempt,
  writeHeldAttempt,
  validatePayment,
  writeAutoPrint,
} from "./counter-sale";

const cap = (over: Partial<FulfilmentCapability>): FulfilmentCapability => ({
  methods: ["ROUTE"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  consistent: true,
  ...over,
});

describe("counterSaleGate: reads capabilities.fulfilment only (SA-650)", () => {
  it("always: the button AND New order opens as the counter sale", () => {
    expect(counterSaleGate(cap({ counter: "always", methods: ["PICKUP"] }))).toEqual({
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: false,
    });
  });
  it("always + SHIP in methods: 'Ship this order instead' is offered", () => {
    expect(counterSaleGate(cap({ counter: "always", methods: ["PICKUP", "SHIP"] }))).toMatchObject({
      opensAsCounter: true,
      offerShipInstead: true,
    });
  });
  it("optional: the button only; never opens as the counter, never offers the ship switch", () => {
    expect(counterSaleGate(cap({ counter: "optional", methods: ["SHIP"] }))).toEqual({
      showButton: true,
      opensAsCounter: false,
      offerShipInstead: false,
    });
  });
  it("off, missing or still loading: nothing", () => {
    const none = { showButton: false, opensAsCounter: false, offerShipInstead: false };
    expect(counterSaleGate(cap({ counter: "off" }))).toEqual(none);
    expect(counterSaleGate(undefined)).toEqual(none);
    expect(counterSaleGate(null)).toEqual(none);
    expect(counterSaleGate(cap({ counter: "bogus" as never }))).toEqual(none);
  });
});

describe("preselectFulfilment: mirrors the resolver (the customer's stored path only if it is a method here)", () => {
  const both = {
    methods: ["ROUTE", "SHIP"] as ("ROUTE" | "SHIP")[],
    staffDefault: "ROUTE" as const,
  };
  const shipOnly = { methods: ["SHIP"] as "SHIP"[], staffDefault: "SHIP" as const };
  it("a stored path that is one of the methods wins over the staff default", () => {
    expect(preselectFulfilment("SHIP", both)).toBe("SHIP");
    expect(preselectFulfilment("ROUTE", { ...both, staffDefault: "SHIP" })).toBe("ROUTE");
  });
  it("a stored ROUTE on a ship-only capability falls to SHIP", () => {
    expect(preselectFulfilment("ROUTE", shipOnly)).toBe("SHIP");
    expect(preselectFulfilment("PICKUP", shipOnly)).toBe("SHIP");
  });
  it("no stored path: the staff default", () => {
    expect(preselectFulfilment(null, shipOnly)).toBe("SHIP");
    expect(preselectFulfilment(undefined, both)).toBe("ROUTE");
  });
  it("no capability: null", () => {
    expect(preselectFulfilment("SHIP", null)).toBeNull();
    expect(preselectFulfilment("SHIP", undefined)).toBeNull();
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
      "WALK_IN_ON_ACCOUNT",
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
  it("a 401 reuses the permission copy and a 429 the as-entered copy (no new text)", () => {
    expect(counterSaleErrorCopy({ response: { status: 401 } })).toBe(
      counterSaleErrorCopy({ response: { status: 403 } }),
    );
    expect(counterSaleErrorCopy({ response: { status: 429 } })).toBe(
      counterSaleErrorCopy({ response: { status: 400 } }),
    );
    expect(counterSaleErrorCopy({ response: { status: 408 } })).toBe(COUNTER_OUTCOME_UNKNOWN_COPY);
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
  it("a 409 COUNTER_SALE_ORDER_CHANGED means the sale EXISTS: unknown outcome, never 'nothing was charged'", () => {
    const err = {
      response: { status: 409, data: { code: "COUNTER_SALE_ORDER_CHANGED", message: "RAW" } },
    };
    expect(isDefinitiveCounterSaleRefusal(err)).toBe(false);
    expect(counterSaleErrorCopy(err)).toBe(COUNTER_OUTCOME_UNKNOWN_COPY);
    expect(counterSaleErrorCopy(err)).not.toMatch(/nothing was charged/i);
  });
  it.each([
    "COUNTER_SALE_ORDER_CHANGED",
    "IDEMPOTENCY_KEY_OTHER_ORDER",
    "IDEMPOTENCY_KEY_CART_MISMATCH",
  ])("a 409 %s means the order exists: unknown outcome, never 'nothing was charged'", (code) => {
    const err = { response: { status: 409, data: { code } } };
    expect(isDefinitiveCounterSaleRefusal(err)).toBe(false);
    expect(counterSaleErrorCopy(err)).toBe(COUNTER_OUTCOME_UNKNOWN_COPY);
  });
  it("only a 404 COUNTER_SALE_NOT_FOUND from the by-key lookup is 'not found'", () => {
    expect(
      isCounterSaleNotFound({
        response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
      }),
    ).toBe(true);
    for (const err of [
      { response: { status: 404 } },
      { response: { status: 404, data: { code: "OTHER" } } },
      { response: { status: 403, data: { code: "COUNTER_SALE_NOT_FOUND" } } },
      { response: { status: 500 } },
      new Error("Network Error"),
      null,
    ])
      expect(isCounterSaleNotFound(err)).toBe(false);
  });
  it("only a 409 COUNTER_SALE_INCOMPLETE is 'incomplete' (a half-written sale: re-POST the same key)", () => {
    expect(
      isCounterSaleIncomplete({
        response: { status: 409, data: { code: "COUNTER_SALE_INCOMPLETE" } },
      }),
    ).toBe(true);
    for (const err of [
      { response: { status: 409 } },
      { response: { status: 409, data: { code: "COUNTER_SALE_ORDER_CHANGED" } } },
      { response: { status: 500, data: { code: "COUNTER_SALE_INCOMPLETE" } } },
      new Error("Network Error"),
      null,
    ])
      expect(isCounterSaleIncomplete(err)).toBe(false);
  });
  it("a 409 COUNTER_SALE_VOIDED is FINAL: the exact copy, definitive, and only that code", () => {
    const voided = {
      response: { status: 409, data: { code: "COUNTER_SALE_VOIDED", message: "RAW" } },
    };
    expect(COUNTER_SALE_VOIDED_COPY).toBe("Voided — start a new sale");
    expect(isCounterSaleVoided(voided)).toBe(true);
    expect(counterSaleErrorCopy(voided)).toBe(COUNTER_SALE_VOIDED_COPY);
    expect(isDefinitiveCounterSaleRefusal(voided)).toBe(true);
    for (const err of [
      { response: { status: 409 } },
      { response: { status: 409, data: { code: "COUNTER_SALE_INCOMPLETE" } } },
      { response: { status: 500, data: { code: "COUNTER_SALE_VOIDED" } } },
      null,
    ])
      expect(isCounterSaleVoided(err)).toBe(false);
  });
  it("a 409 COUNTER_SALE_CHANGED is FINAL: the exact copy, definitive, and only that code", () => {
    const changed = {
      response: { status: 409, data: { code: "COUNTER_SALE_CHANGED", message: "RAW" } },
    };
    expect(COUNTER_SALE_CHANGED_COPY).toBe(
      "This sale was changed after it was rung — check with the office.",
    );
    expect(isCounterSaleChanged(changed)).toBe(true);
    expect(counterSaleErrorCopy(changed)).toBe(COUNTER_SALE_CHANGED_COPY);
    expect(isDefinitiveCounterSaleRefusal(changed)).toBe(true);
    expect(finalCounterSaleCopy(changed)).toBe(COUNTER_SALE_CHANGED_COPY);
    for (const err of [
      { response: { status: 409 } },
      { response: { status: 409, data: { code: "COUNTER_SALE_VOIDED" } } },
      { response: { status: 500, data: { code: "COUNTER_SALE_CHANGED" } } },
      null,
    ])
      expect(isCounterSaleChanged(err)).toBe(false);
  });
  it("finalCounterSaleCopy: voided and changed only, null for everything else", () => {
    expect(
      finalCounterSaleCopy({ response: { status: 409, data: { code: "COUNTER_SALE_VOIDED" } } }),
    ).toBe(COUNTER_SALE_VOIDED_COPY);
    for (const err of [{ response: { status: 409 } }, { response: { status: 503 } }, null])
      expect(finalCounterSaleCopy(err)).toBeNull();
  });
  it("any OTHER 409 stays a definitive refusal", () => {
    for (const data of [undefined, {}, { code: "SOME_OTHER_CODE" }]) {
      const err = { response: { status: 409, data } };
      expect(isDefinitiveCounterSaleRefusal(err)).toBe(true);
      expect(counterSaleErrorCopy(err)).toMatch(/nothing was charged/i);
    }
  });
  it("only 400 / 401 / 403 / 404 / 409 / 422 / 429 prove nothing was written", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429])
      expect(isDefinitiveCounterSaleRefusal({ response: { status } })).toBe(true);
    for (const status of [408, 500, 502, 503, 504])
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

/**
 * A sale recovered through "Check sale status" is judged against what the screen SUBMITTED for that key, because
 * storage cannot say whether "no tender" means On account or a failed tender, nor whether a partial was intended:
 * expected = ON_ACCOUNT 0 / CASH min(tendered, total) / CARD, CHECK total.
 */

describe("pickupBalanceDue (what is left to collect before pickup-complete)", () => {
  it("no invoice yet: the order total", () => {
    expect(pickupBalanceDue(42.5, [])).toBe(42.5);
  });
  it("sums the server's balanceDue over live invoices; VOID is ignored", () => {
    expect(
      pickupBalanceDue(100, [
        { status: "SENT", total: 60, balanceDue: 10.1 },
        { status: "PARTIAL", total: 40, balanceDue: 0.2 },
        { status: "VOID", total: 40, balanceDue: 40 },
      ]),
    ).toBe(10.3);
  });
  it("WRITTEN_OFF is ignored like VOID", () => {
    expect(
      pickupBalanceDue(100, [
        { status: "SENT", total: 60, balanceDue: 10 },
        { status: "WRITTEN_OFF", total: 40, balanceDue: 40 },
      ]),
    ).toBe(10);
    expect(pickupBalanceDue(25, [{ status: "WRITTEN_OFF", total: 25, balanceDue: 25 }])).toBe(25);
  });
  it("a settled invoice is nothing to collect", () => {
    expect(pickupBalanceDue(30, [{ status: "PAID", total: 30, balanceDue: 0 }])).toBe(0);
  });
  it("an invoice without a balanceDue falls back to its total", () => {
    expect(pickupBalanceDue(30, [{ status: "DRAFT", total: 30 }])).toBe(30);
  });
});

describe("pickupCompleteErrorCopy", () => {
  const err = (status: number, code: string) => ({ response: { status, data: { code } } });
  it("maps PICKUP_NOT_READY and PICKUP_ONLY to fixed copy", () => {
    expect(pickupCompleteErrorCopy(err(409, "PICKUP_NOT_READY"))).toBe(PICKUP_NOT_READY_COPY);
    expect(pickupCompleteErrorCopy(err(400, "PICKUP_ONLY"))).toBe(PICKUP_ONLY_COPY);
  });
  it("maps WALK_IN_NO_ACCOUNT and COUNTER_CHECK_NUMBER_REQUIRED to fixed copy, not the server text", () => {
    const walk = pickupCompleteErrorCopy({
      response: { status: 400, data: { code: "WALK_IN_NO_ACCOUNT", message: "raw server text" } },
    });
    expect(walk).toBe(PAYMENT_PROBLEM_COPY.WALK_IN_ON_ACCOUNT);
    const check = pickupCompleteErrorCopy({
      response: {
        status: 400,
        data: { code: "COUNTER_CHECK_NUMBER_REQUIRED", message: "raw server text" },
      },
    });
    expect(check).toBe(PAYMENT_PROBLEM_COPY.CHECK_NUMBER_REQUIRED);
  });
  it.each([
    [409, "PICKUP_KEY_CONFLICT", PICKUP_KEY_CONFLICT_COPY],
    [409, "PICKUP_INVOICE_MISSING", PICKUP_INVOICE_MISSING_COPY],
    [409, "WALK_IN_OPEN_CREDIT", PICKUP_WALK_IN_CREDIT_COPY],
    [400, "COUNTER_TENDER_SHORT", PICKUP_TENDER_SHORT_COPY],
    [200, "PICKUP_PAYMENT_REQUIRED", PICKUP_PAYMENT_REQUIRED_COPY],
  ])("%s %s maps to fixed copy, never the server text", (status, code, copy) => {
    expect(
      pickupCompleteErrorCopy({ response: { status, data: { code, message: "raw server text" } } }),
    ).toBe(copy);
  });
  it("the copy is the agreed wording", () => {
    expect(PICKUP_PAYMENT_REQUIRED_COPY).toBe(
      "A balance is due on this order now. Take payment to finish.",
    );
    expect(PICKUP_TENDER_SHORT_COPY).toBe("A walk-in customer must pay the full balance.");
    expect(PICKUP_KEY_CONFLICT_COPY).toBe("Already picked up. Record any payment on the invoice.");
    expect(PICKUP_INVOICE_MISSING_COPY).toBe(
      "The order may be picked up, but its invoice isn't ready yet. Retry to finish.",
    );
    expect(PICKUP_WALK_IN_CREDIT_COPY).toBe(
      "This walk-in has open credit. Resolve it on the customer before handing over.",
    );
  });
  it("anything else is the generic retry copy, never the server message", () => {
    expect(
      pickupCompleteErrorCopy({ response: { status: 500, data: { message: "boom internals" } } }),
    ).toBe("Couldn't complete the pickup. Check the order and try again.");
  });
});

describe("counterSaleErrorCopy: 409 first-attempt codes say what to do", () => {
  it("WALK_IN_OPEN_CREDIT and COUNTER_SALE_KEY_CONFLICT have their own copy", () => {
    expect(
      counterSaleErrorCopy({ response: { status: 409, data: { code: "WALK_IN_OPEN_CREDIT" } } }),
    ).toBe("This walk-in has open credit. Resolve it on the customer, then ring the sale again.");
    expect(
      counterSaleErrorCopy({
        response: { status: 409, data: { code: "COUNTER_SALE_KEY_CONFLICT" } },
      }),
    ).toBe("That sale reference was already used. Ring the sale again.");
  });
  it("B1209: 409 COUNTER_TENDER_SHORT is fixed copy and a DEFINITIVE refusal (nothing was written, the key is released)", () => {
    const err = {
      response: { status: 409, data: { code: "COUNTER_TENDER_SHORT", message: "raw server text" } },
    };
    expect(counterSaleErrorCopy(err)).toBe("A walk-in customer must pay the full balance.");
    expect(isDefinitiveCounterSaleRefusal(err)).toBe(true);
  });
});

describe("held attempt: minimal customer, validated read", () => {
  const SK = "rf.counterSale.heldAttempt:acme:u-a";
  const snap = (over: Record<string, unknown> = {}) =>
    ({
      key: "k1",
      dto: { payment: { method: "CASH" } },
      next: false,
      estimate: { total: 2.5, change: 0 },
      lines: [{ tempId: "t", productId: "p1", name: "Cola", unitPrice: 2.5, qty: 1 }],
      customer: null,
      method: "CASH",
      tendered: "",
      reference: "",
      ...over,
    }) as never;
  beforeEach(() => window.sessionStorage.clear());

  it("stores only id, businessName, pricingTier, fulfillPath of the customer", () => {
    writeHeldAttempt(
      SK,
      snap({
        customer: {
          id: "c1",
          businessName: "Acme",
          pricingTier: 2,
          fulfillPath: "PICKUP",
          email: "a@b.c",
          phone: "555",
          address: "1 Main",
          notes: "x",
        },
      }),
    );
    const c = JSON.parse(window.sessionStorage.getItem(SK) as string).customer;
    expect(Object.keys(c).sort()).toEqual(["businessName", "fulfillPath", "id", "pricingTier"]);
  });

  it("reads a valid attempt back", () => {
    writeHeldAttempt(SK, snap());
    expect((readHeldAttempt(SK) as { key: string }).key).toBe("k1");
  });

  it.each([
    ["corrupt JSON", () => window.sessionStorage.setItem(SK, "{nope")],
    [
      "non-numeric quantity",
      () =>
        window.sessionStorage.setItem(
          SK,
          JSON.stringify(
            snap({ lines: [{ tempId: "t", productId: "p1", name: "C", unitPrice: 1, qty: "x" }] }),
          ),
        ),
    ],
    [
      "missing key",
      () => window.sessionStorage.setItem(SK, JSON.stringify(snap({ key: undefined }))),
    ],
  ])("%s -> corrupt, and the entry is removed", (_n, seed) => {
    seed();
    expect(readHeldAttempt(SK)).toBe("corrupt");
    expect(window.sessionStorage.getItem(SK)).toBeNull();
  });

  it("heldAttemptKey is unchanged", () => {
    expect(heldAttemptKey("acme", "u-a")).toBe(SK);
  });
});
