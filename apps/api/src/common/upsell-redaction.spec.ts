import { redactUpsellForCustomer, redactUpsellLines } from "./upsell-redaction";

describe("redactUpsellForCustomer", () => {
  it("strips the base + pill from an UPSELL order line and drops product cost/list fields", () => {
    const order = {
      lineItems: [
        {
          priceType: "MANUAL",
          unitPrice: 12,
          originalPrice: 10,
          product: { id: "p1", name: "X", pricePerUnit: 10, averageCost: 4 },
        },
      ],
    };
    redactUpsellForCustomer(order);
    const li = order.lineItems[0];
    expect(li.originalPrice).toBeNull();
    expect(li.priceType).toBe("STANDARD");
    // Money is untouched — the customer still pays the upsold price.
    expect(li.unitPrice).toBe(12);
    expect(li.product).not.toHaveProperty("pricePerUnit");
    expect(li.product).not.toHaveProperty("averageCost");
  });

  it("leaves a DISCOUNT line intact so the buyer keeps seeing their savings", () => {
    const order = {
      lineItems: [{ priceType: "DISCOUNTED", unitPrice: 8, originalPrice: 10, product: null }],
    };
    redactUpsellForCustomer(order);
    expect(order.lineItems[0].originalPrice).toBe(10);
    expect(order.lineItems[0].priceType).toBe("DISCOUNTED");
  });

  it("redacts invoice items (items[]) too and is idempotent", () => {
    const invoice = {
      items: [{ priceType: "MANUAL", unitPrice: 12, originalPrice: 10 }],
    };
    redactUpsellForCustomer(invoice);
    redactUpsellForCustomer(invoice); // second pass is a no-op
    expect(invoice.items[0].originalPrice).toBeNull();
    expect(invoice.items[0].priceType).toBe("STANDARD");
  });

  it("handles null/empty entities safely", () => {
    expect(redactUpsellForCustomer(null)).toBeNull();
    expect(() => redactUpsellLines(undefined)).not.toThrow();
  });
});
