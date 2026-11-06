import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { OrderLineItemsTable } from "@/app/(dashboard)/orders/[id]/_components/OrderLineItemsTable";
import { linePriceTag } from "./line-price-tag";

describe("linePriceTag", () => {
  it("SPECIAL: strikes the original and shows Special (green)", () => {
    expect(linePriceTag({ priceType: "SPECIAL", originalPrice: 80, unitPrice: 65 })).toEqual({
      label: "Special",
      tone: "emerald",
      strikeOriginal: true,
    });
  });

  it("SPECIAL with no original price has nothing to strike", () => {
    expect(linePriceTag({ priceType: "SPECIAL", originalPrice: null, unitPrice: 65 })).toEqual({
      label: "Special",
      tone: "emerald",
      strikeOriginal: false,
    });
  });

  // SA-1077 / W-1093: a strike reads as "this was the price". On a tier above Retail it would cross out the LOWER list beside the
  // higher tier price, so a SPECIAL line charged above its list keeps the pill and never strikes the base (as an Upsell does).
  it("SPECIAL above its list (12 over 10) keeps the Special pill and never strikes the lower list", () => {
    expect(linePriceTag({ priceType: "SPECIAL", originalPrice: 10, unitPrice: 12 })).toEqual({
      label: "Special",
      tone: "emerald",
      strikeOriginal: false,
    });
  });

  it("SPECIAL below its list (8 under 10) still strikes it", () => {
    expect(
      linePriceTag({ priceType: "SPECIAL", originalPrice: 10, unitPrice: 8 })?.strikeOriginal,
    ).toBe(true);
  });

  it("MANUAL above the original is an Upsell — the base is never struck", () => {
    expect(linePriceTag({ priceType: "MANUAL", originalPrice: 50, unitPrice: 65 })).toEqual({
      label: "Upsell",
      tone: "emerald",
      strikeOriginal: false,
    });
  });

  it.each([
    ["DISCOUNTED", "Discounted"],
    ["PROMO", "Promo"],
    ["MANUAL", "Adjusted"],
  ])("%s below the original strikes it and reads %s (amber)", (priceType, label) => {
    expect(linePriceTag({ priceType, originalPrice: 80, unitPrice: 65 })).toEqual({
      label,
      tone: "amber",
      strikeOriginal: true,
    });
  });

  it("STANDARD, a missing original, and a missing type show no tag", () => {
    expect(linePriceTag({ priceType: "STANDARD", originalPrice: 80, unitPrice: 65 })).toBeNull();
    expect(
      linePriceTag({ priceType: "DISCOUNTED", originalPrice: null, unitPrice: 65 }),
    ).toBeNull();
    expect(linePriceTag({ priceType: "MANUAL", originalPrice: null, unitPrice: 65 })).toBeNull();
    expect(linePriceTag({ unitPrice: 65 })).toBeNull();
  });

  it("accepts Prisma Decimal strings", () => {
    expect(
      linePriceTag({ priceType: "MANUAL", originalPrice: "50.00", unitPrice: "65.00" })?.label,
    ).toBe("Upsell");
  });
});

/**
 * Parity with the table the card list replaces: for the same order line, the label the table
 * prints and the label `linePriceTag` returns must be the same word (or both absent).
 */
describe("linePriceTag ↔ OrderLineItemsTable parity", () => {
  const CASES: [string, number | null][] = [
    ["SPECIAL", 80],
    ["MANUAL", 50], // upsell (unit 65 > 50)
    ["MANUAL", 90], // adjusted (unit 65 < 90)
    ["DISCOUNTED", 80],
    ["PROMO", 80],
    ["DISCOUNTED", null],
    ["STANDARD", 80],
    ["MANUAL", null],
  ];

  it.each(CASES)("priceType %s, original %s", (priceType, originalPrice) => {
    const item = {
      id: "li-1",
      productId: "p-1",
      product: { id: "p-1", name: "Sample Cola 12oz", unit: "each" },
      qty: 1,
      unitPrice: 65,
      priceType,
      originalPrice,
      status: "PENDING",
      subtotal: 65,
    } as unknown as OrderItem;
    render(<OrderLineItemsTable lineItems={[item]} orderStatus="CONFIRMED" total={65} />);

    const tag = linePriceTag({ priceType, originalPrice, unitPrice: 65 });
    for (const word of ["Special", "Upsell", "Promo", "Adjusted", "Discounted"]) {
      const inTable = screen.queryByText(word) !== null;
      expect(inTable).toBe(tag?.label === word);
    }
  });
});

/** The table's struck list price (`.strike`) follows the same rule as the tag: a SPECIAL line above its list strikes nothing. */
describe("OrderLineItemsTable: the struck list price on a SPECIAL line (SA-1077 / W-1093)", () => {
  const special = (unitPrice: number, originalPrice: number) =>
    ({
      id: "li-1",
      productId: "p-1",
      product: { id: "p-1", name: "Sample Cola 12oz", unit: "each" },
      qty: 1,
      unitPrice,
      priceType: "SPECIAL",
      originalPrice,
      status: "PENDING",
      subtotal: unitPrice,
    }) as unknown as OrderItem;

  it("12 over a list of 10: the Special pill stays, the list price is not struck", () => {
    const { container } = render(
      <OrderLineItemsTable lineItems={[special(12, 10)]} orderStatus="CONFIRMED" total={12} />,
    );
    expect(screen.getAllByText("Special").length).toBeGreaterThan(0);
    expect(container.querySelector(".strike")).toBeNull();
  });

  it("8 under a list of 10: the list price is struck", () => {
    const { container } = render(
      <OrderLineItemsTable lineItems={[special(8, 10)]} orderStatus="CONFIRMED" total={8} />,
    );
    expect(container.querySelector(".strike")).not.toBeNull();
  });
});
