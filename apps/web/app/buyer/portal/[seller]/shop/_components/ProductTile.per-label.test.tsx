import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { BuyerProduct } from "@routeflow/types";
import { ProductTile } from "./ProductTile";

/**
 * B1383 PR-B: the shop tile's price line comes from `pricedPerLabel`. A boxed product whose unit is a piece word
 * ("can") quotes its price per BOX, never "per can".
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const product = (over: Partial<BuyerProduct> = {}): BuyerProduct => ({
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
  isFeatured: false,
  isNew: false,
  isDeal: false,
  imageUrls: [],
  inStock: true,
  stockStatus: "IN_STOCK",
  stockLeft: null,
  ...over,
});

function setup(p: BuyerProduct) {
  render(
    <ProductTile
      product={p}
      sellerSlug="acme"
      cartItem={undefined}
      promoRules={[]}
      onAdd={jest.fn()}
      onUpdateQty={jest.fn()}
      onToggleFavorite={jest.fn()}
      onToggleStockAlert={jest.fn()}
      isFavorite={false}
    />,
  );
}

describe("ProductTile price line (B1383)", () => {
  it("a boxed product with a piece-word unit reads per box with the pack count", () => {
    setup(product());
    expect(screen.getByText("per box (12 cans)")).toBeInTheDocument();
    expect(screen.queryByText(/per can/)).not.toBeInTheDocument();
  });

  it("a product sold by the piece reads as before", () => {
    setup(product({ unit: "lb", unitsPerBox: null }));
    expect(screen.getByText("per lb")).toBeInTheDocument();
  });
});
