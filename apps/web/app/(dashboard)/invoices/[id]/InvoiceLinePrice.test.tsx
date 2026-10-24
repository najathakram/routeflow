import * as React from "react";
import { render, screen } from "@testing-library/react";
import { showOriginalPrice } from "@routeflow/pricing";
import { InvoiceLinePrice } from "./InvoiceLinePrice";

/**
 * Row 322c: the invoice detail's struck-through original price follows pricing's `showOriginalPrice` (the rule the invoice PDF,
 * the invoice email and every receipt use), not an inline priceType ladder. Placeholders only.
 */
const cell = (item: Record<string, unknown>, hideOriginal = false) => {
  const { container } = render(
    <div>
      <InvoiceLinePrice item={item as never} hideOriginal={hideOriginal} />
    </div>,
  );
  return container;
};
const struck = (c: HTMLElement) => c.querySelector(".strike");

describe("InvoiceLinePrice: the struck original follows showOriginalPrice", () => {
  it.each(["SPECIAL", "DISCOUNTED", "PROMO", "MANUAL"])(
    "a lowered %s line strikes the stored original and shows the charged price",
    (priceType) => {
      const c = cell({ priceType, originalPrice: "12.00", unitPrice: "10.00" });
      expect(struck(c)).toHaveTextContent("$12.00");
      expect(c).toHaveTextContent("$10.00");
    },
  );

  it("a SPECIAL or DISCOUNTED line with NO stored original strikes nothing (never a struck $0.00)", () => {
    for (const priceType of ["SPECIAL", "DISCOUNTED"]) {
      const c = cell({ priceType, originalPrice: null, unitPrice: "10.00" });
      expect(struck(c)).toBeNull();
      expect(c).not.toHaveTextContent("$0.00");
      expect(c).toHaveTextContent("$10.00");
    }
  });

  it("the tenant's hideOriginalPrice strikes nothing on any line type", () => {
    for (const priceType of ["SPECIAL", "DISCOUNTED", "PROMO", "MANUAL"]) {
      const c = cell({ priceType, originalPrice: "12.00", unitPrice: "10.00" }, true);
      expect(struck(c)).toBeNull();
      expect(c).toHaveTextContent("$10.00");
    }
  });

  it("a MANUAL upsell (charged above the base) never exposes the lower base", () => {
    const c = cell({ priceType: "MANUAL", originalPrice: "12.00", unitPrice: "14.00" });
    expect(struck(c)).toBeNull();
    expect(c).not.toHaveTextContent("$12.00");
    expect(c).toHaveTextContent("$14.00");
    expect(c).toHaveTextContent("Upsell");
  });

  it("a plain STANDARD line shows its price alone", () => {
    const c = cell({ priceType: "STANDARD", originalPrice: null, unitPrice: "3.00" });
    expect(struck(c)).toBeNull();
    expect(c).toHaveTextContent("$3.00");
  });

  it("agrees with showOriginalPrice for every case above", () => {
    const cases = [
      { priceType: "SPECIAL", originalPrice: null, unitPrice: "10.00" },
      { priceType: "DISCOUNTED", originalPrice: "12.00", unitPrice: "10.00" },
      { priceType: "PROMO", originalPrice: "12.00", unitPrice: "10.00" },
      { priceType: "MANUAL", originalPrice: "12.00", unitPrice: "14.00" },
      { priceType: "MANUAL", originalPrice: "12.00", unitPrice: "11.00" },
      { priceType: "STANDARD", originalPrice: null, unitPrice: "3.00" },
    ];
    for (const item of cases)
      for (const hide of [false, true]) {
        const c = cell(item, hide);
        expect(struck(c) !== null).toBe(showOriginalPrice(item, hide));
        c.remove();
      }
  });
});
