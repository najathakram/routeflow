import { productSalesSummaryLine, productSaleRowTarget } from "../lib/product-sales-logic";
import type { ProductSalesSummary } from "../lib/api/product-sales";

function summary(overrides: Partial<ProductSalesSummary> = {}): ProductSalesSummary {
  return {
    count: 3,
    buyers: 2,
    totalQty: 30,
    totalRevenue: 150,
    minPrice: 4.5,
    maxPrice: 6,
    avgPrice: 5,
    ...overrides,
  };
}

describe("productSalesSummaryLine", () => {
  it("renders buyers, qty, and the price range with avg", () => {
    expect(productSalesSummaryLine(summary())).toBe("2 buyers · 30 sold · $4.50–$6.00 avg $5.00");
  });

  it("uses the singular 'buyer' for exactly one buyer", () => {
    expect(productSalesSummaryLine(summary({ buyers: 1 }))).toBe(
      "1 buyer · 30 sold · $4.50–$6.00 avg $5.00",
    );
  });

  it("collapses the range to one price when every sale was at the same price", () => {
    expect(productSalesSummaryLine(summary({ minPrice: 5, maxPrice: 5, avgPrice: 5 }))).toBe(
      "2 buyers · 30 sold · $5.00 avg $5.00",
    );
  });

  it("drops the price segment when there is no price data (zero-sales)", () => {
    expect(
      productSalesSummaryLine(
        summary({ buyers: 0, totalQty: 0, minPrice: null, maxPrice: null, avgPrice: null }),
      ),
    ).toBe("0 buyers · 0 sold");
  });
});

describe("productSaleRowTarget", () => {
  it("targets the order when orderId is set", () => {
    expect(productSaleRowTarget({ orderId: "ord-1", invoiceId: "inv-1" })).toEqual({
      screen: "order",
      id: "ord-1",
    });
  });

  it("falls back to the invoice when orderId is null", () => {
    expect(productSaleRowTarget({ orderId: null, invoiceId: "inv-1" })).toEqual({
      screen: "invoice",
      id: "inv-1",
    });
  });
});
