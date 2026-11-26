import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { BuyerProductDetail } from "@/lib/api/buyer";
import { pricedPerLabel } from "@routeflow/pricing";
import { DetailActions } from "./DetailActions";

/** B1383 PR-B: the product page's price line comes from `pricedPerLabel` (a box price never reads "per can"). */
const detail = (over: Partial<BuyerProductDetail> = {}): BuyerProductDetail =>
  ({
    id: "p1",
    name: "Acme Cola",
    description: null,
    sku: "C-1",
    barcode: null,
    unit: "can",
    category: "Drinks",
    buyerPrice: 12,
    unitsPerBox: 12,
    thumbnailUrl: null,
    imageKeys: [],
    imageUrls: [],
    variants: [],
    isFeatured: false,
    isNew: false,
    isDeal: false,
    inStock: true,
    stockStatus: "IN_STOCK",
    stockLeft: null,
    ...over,
  }) as BuyerProductDetail;

function setup(p: BuyerProductDetail) {
  render(
    <DetailActions
      product={p}
      cartItem={undefined}
      promoRules={[]}
      promotions={[]}
      onAdd={jest.fn()}
      onUpdateQty={jest.fn()}
      isAlertSubscribed={false}
      onToggleStockAlert={jest.fn()}
    />,
  );
}

describe("DetailActions price line (B1383)", () => {
  it("a boxed product with a piece-word unit reads per box with the pack count", () => {
    setup(detail());
    expect(screen.getByText("per box (12 cans)")).toBeInTheDocument();
    expect(screen.queryByText(/per can/)).not.toBeInTheDocument();
  });

  it("a pack-word unit keeps the count the old page showed, from the helper", () => {
    setup(detail({ unit: "case" }));
    const expected = pricedPerLabel({ unit: "case", unitsPerBox: 12 }).perText;
    expect(expected).toBe("per case (12 pieces)");
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("a product sold by the piece reads as before", () => {
    setup(detail({ unit: "lb", unitsPerBox: null }));
    expect(screen.getByText("per lb")).toBeInTheDocument();
  });
});
