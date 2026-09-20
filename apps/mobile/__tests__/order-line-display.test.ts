import {
  displayLineStatus,
  displayProductName,
  linePriceTag,
  orderLineCardModel,
  orderLineName,
  splitProductName,
} from "../lib/order-line-display";

/**
 * The operator order-detail line card (T8) — pure logic. Fixtures are placeholders (`Sample …`).
 * These mirror the web tests (`LineItemRowReadOnly.test.tsx`, `line-price-tag.test.tsx`,
 * `OrderLineItemCards.test.tsx`); the web-side parity test runs both implementations together.
 */

function line(over: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    productId: "p-1",
    product: { name: "Sample Cola 12oz", unit: "each", sku: "100200300" },
    qty: 8,
    unitPrice: 65,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 520,
    deliveredQty: 0,
    ...over,
  } as Parameters<typeof orderLineCardModel>[0];
}

describe("splitProductName", () => {
  it("splits at the FIRST separator: family stem, flavor + pack anchor", () => {
    expect(splitProductName("Sample Pod - Strawberry Banana - 5ct")).toEqual({
      stem: "Sample Pod",
      anchor: "Strawberry Banana - 5ct",
    });
  });

  it("a flat name has no stem; a bare hyphen or an empty side does not split", () => {
    expect(splitProductName("Sample Chips 1oz")).toEqual({
      stem: null,
      anchor: "Sample Chips 1oz",
    });
    expect(splitProductName("Cola-12pk").stem).toBeNull();
    expect(splitProductName(" - Leading").stem).toBeNull();
    expect(splitProductName("Trailing - ").stem).toBeNull();
  });
});

describe("orderLineName / displayProductName", () => {
  it("composes a catalog variant as '<Parent> - <Variant>'", () => {
    expect(
      orderLineName({
        product: {
          name: "Strawberry Banana",
          variantName: "Strawberry Banana",
          parentProductId: "p",
          parent: { name: "Sample Pod" },
        },
      }),
    ).toBe("Sample Pod - Strawberry Banana");
  });

  it("degrades to the bare variant when the parent is not loaded, and never doubles a prefix", () => {
    expect(displayProductName({ name: "X", variantName: "Berry", parentProductId: "p" })).toBe(
      "Berry",
    );
    expect(
      displayProductName({
        name: "x",
        variantName: "Sample Pod - Berry",
        parentProductId: "p",
        parent: { name: "Sample Pod" },
      }),
    ).toBe("Sample Pod - Berry");
  });

  it("a standalone product keeps its name; an ad-hoc line uses its label; neither is null", () => {
    expect(orderLineName({ product: { name: "Sample Chips" } })).toBe("Sample Chips");
    expect(orderLineName({ product: null, name: "Delivery surcharge" })).toBe("Delivery surcharge");
    expect(orderLineName({})).toBeNull();
  });
});

describe("displayLineStatus", () => {
  const li = (over: Record<string, unknown> = {}) => ({
    status: "PENDING",
    deliveredQty: 0,
    qty: 8,
    ...over,
  });

  it("a real line-level outcome always wins", () => {
    for (const status of ["CANCELLED", "DELIVERED", "PARTIAL"]) {
      expect(displayLineStatus(li({ status, deliveredQty: 8 }), "CONFIRMED")).toBe(status);
    }
  });

  it("derives DELIVERED / PARTIAL from delivery data, tolerating float noise", () => {
    expect(displayLineStatus(li({ deliveredQty: 8 }), "OUT_FOR_DELIVERY")).toBe("DELIVERED");
    expect(displayLineStatus(li({ deliveredQty: 3 }), "OUT_FOR_DELIVERY")).toBe("PARTIAL");
    expect(displayLineStatus(li({ qty: 0.3, deliveredQty: 0.1 + 0.2 }), "CONFIRMED")).toBe(
      "DELIVERED",
    );
  });

  it("falls back to the order's terminal state, else the stored status", () => {
    expect(displayLineStatus(li(), "DELIVERED")).toBe("DELIVERED");
    expect(displayLineStatus(li(), "CONFIRMED")).toBe("PENDING");
  });
});

describe("linePriceTag", () => {
  it.each([
    ["SPECIAL", 80, 65, "Special", "green", true],
    ["MANUAL", 50, 65, "Upsell", "green", false],
    ["MANUAL", 90, 65, "Adjusted", "orange", true],
    ["DISCOUNTED", 80, 65, "Discounted", "orange", true],
    ["PROMO", 80, 65, "Promo", "orange", true],
  ])("%s original %s unit %s → %s", (priceType, original, unit, label, tone, strike) => {
    expect(linePriceTag({ priceType, originalPrice: original, unitPrice: unit })).toEqual({
      label,
      tone,
      strikeOriginal: strike,
    });
  });

  it("no tag for STANDARD, a missing original, or no type", () => {
    expect(linePriceTag({ priceType: "STANDARD", originalPrice: 80, unitPrice: 65 })).toBeNull();
    expect(
      linePriceTag({ priceType: "DISCOUNTED", originalPrice: null, unitPrice: 65 }),
    ).toBeNull();
    expect(linePriceTag({ unitPrice: 65 })).toBeNull();
  });
});

describe("orderLineCardModel", () => {
  it("REG: a plain line never prints the raw product.unit ('1 Box' / '1 Vape') — 'N × $price'", () => {
    const m = orderLineCardModel(
      line({ product: { name: "Sample Pod", unit: "Vape", sku: "1" }, qty: 1 }),
      "CONFIRMED",
    );
    expect(m.qtyPriceLine).toBe("1 × $65.00");
    expect(m.qtyPriceLine).not.toMatch(/vape|box/i);
  });

  it("boxed: split qty + per-box price; total is the STORED subtotal, not qty × price", () => {
    const m = orderLineCardModel(
      line({ unitPrice: 30, qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12, subtotal: 67.5 }),
      "CONFIRMED",
    );
    expect(m.qtyPriceLine).toBe("2 boxes + 3 pcs · $30.00 / box of 12");
    expect(m.total).toBe("$67.50");
  });

  it("falls back to the live product's pack size, and to computeLineSubtotal with free units", () => {
    const m = orderLineCardModel(
      line({
        subtotal: null,
        unitPrice: 30,
        qty: 36,
        boxes: 3,
        pieces: 0,
        unitsPerBox: null,
        promoFreeUnits: 1,
        product: { name: "X", unit: "case", unitsPerBox: 12 },
      }),
      "CONFIRMED",
    );
    expect(m.qtyPriceLine).toBe("3 boxes · $30.00 / box of 12");
    expect(m.total).toBe("$60.00"); // (3 - 1 free) boxes x $30
    expect(m.freeLabel).toBe("1 free");
  });

  it("a stored split with no known pack size keeps the split, priced per unit", () => {
    const m = orderLineCardModel(
      line({
        boxes: 2,
        pieces: 3,
        unitsPerBox: null,
        product: { name: "X", unit: "u" },
        qty: 27,
        unitPrice: 30,
        subtotal: 810,
      }),
      "CONFIRMED",
    );
    expect(m.qtyPriceLine).toBe("2 boxes + 3 pcs × $30.00");
  });

  it("splits a long name into stem + anchor and composes a variant", () => {
    const m = orderLineCardModel(
      line({
        product: {
          name: "Strawberry Banana",
          variantName: "Strawberry Banana",
          parentProductId: "pp",
          parent: { name: "Sample Pod" },
          unit: "each",
        },
      }),
      "CONFIRMED",
    );
    expect(m.stem).toBe("Sample Pod");
    expect(m.anchor).toBe("Strawberry Banana");
  });

  it("custom (unlisted) line: flagged, labelled by its own name, no sku", () => {
    const m = orderLineCardModel(
      line({ productId: null, product: null, name: "Delivery surcharge" }),
      "X",
    );
    expect(m).toMatchObject({ custom: true, anchor: "Delivery surcharge", sku: null, stem: null });
  });

  it("cancelled: no dollar total (rendered as a dash), a red pill", () => {
    const m = orderLineCardModel(line({ status: "CANCELLED" }), "CONFIRMED");
    expect(m.cancelled).toBe(true);
    expect(m.total).toBeNull();
    expect(m.status).toEqual({ label: "Cancelled", variant: "red" });
  });

  it("status pill is derived from delivery data; a plain pending line has none", () => {
    expect(orderLineCardModel(line({ deliveredQty: 3 }), "OUT_FOR_DELIVERY").status).toEqual({
      label: "Partial",
      variant: "orange",
    });
    expect(orderLineCardModel(line(), "CONFIRMED").status).toBeNull();
    expect(orderLineCardModel(line(), "DELIVERED").status).toEqual({
      label: "Delivered",
      variant: "green",
    });
  });

  it("'N of M delivered' only past dispatch and only for a short line (deliveredQty is 0, not null)", () => {
    expect(orderLineCardModel(line({ deliveredQty: 3 }), "PARTIALLY_DELIVERED").deliveryText).toBe(
      "3 of 8 delivered",
    );
    expect(orderLineCardModel(line({ deliveredQty: 0 }), "CONFIRMED").deliveryText).toBeNull();
    expect(orderLineCardModel(line({ deliveredQty: 8 }), "DELIVERED").deliveryText).toBeNull();
  });

  it("carries the price tag with its struck original, the free label, and the trimmed note", () => {
    const m = orderLineCardModel(
      line({
        priceType: "DISCOUNTED",
        originalPrice: 80,
        promoFreeUnits: 2,
        notes: "  leave at dock ",
      }),
      "CONFIRMED",
    );
    expect(m.tag).toMatchObject({ label: "Discounted", tone: "orange", originalText: "$80.00" });
    expect(m.freeLabel).toBe("2 free");
    expect(m.note).toBe("leave at dock");
  });

  it("an upsell shows the tag but never the base price", () => {
    const m = orderLineCardModel(line({ priceType: "MANUAL", originalPrice: 50 }), "CONFIRMED");
    expect(m.tag).toMatchObject({ label: "Upsell", originalText: null });
  });
});
