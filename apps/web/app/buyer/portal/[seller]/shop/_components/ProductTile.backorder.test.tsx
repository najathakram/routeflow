import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BuyerProduct } from "@routeflow/types";
import { ProductTile } from "./ProductTile";

/**
 * OOS PR2 (R3c): the shop tile reads the server's `canBackorder`. Out of stock + canBackorder shows
 * "Add" and "Ships when restocked" (not "Notify me"); out of stock + cannot (or unknown) is blocked
 * exactly as before.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const product = (over: Partial<BuyerProduct> = {}): BuyerProduct => ({
  id: "p1",
  name: "Widget",
  description: null,
  sku: "W-1",
  barcode: null,
  unit: "ea",
  category: "Snacks",
  buyerPrice: 5,
  unitsPerBox: null,
  thumbnailUrl: null,
  imageKeys: [],
  isFeatured: false,
  isNew: false,
  isDeal: false,
  imageUrls: [],
  inStock: false,
  stockStatus: "OUT_OF_STOCK",
  stockLeft: null,
  ...over,
});

function setup(p: BuyerProduct) {
  const onAdd = jest.fn();
  const onToggleStockAlert = jest.fn();
  render(
    <ProductTile
      product={p}
      sellerSlug="acme"
      cartItem={undefined}
      promoRules={[]}
      onAdd={onAdd}
      onUpdateQty={jest.fn()}
      onToggleFavorite={jest.fn()}
      onToggleStockAlert={onToggleStockAlert}
      isFavorite={false}
    />,
  );
  return { onAdd, onToggleStockAlert };
}

describe("ProductTile — out of stock + canBackorder", () => {
  it("shows 'Ships when restocked' and an enabled Add; no Notify me, no 'Out of stock'", () => {
    const { onAdd } = setup(product({ canBackorder: true }));
    expect(screen.getByText("Ships when restocked")).toBeInTheDocument();
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /notify me/i })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: /add/i });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it.each([[false], [undefined]])(
    "canBackorder %p (unknown fails closed): the plain 'Out of stock' and Notify me, as before",
    (canBackorder) => {
      const { onAdd, onToggleStockAlert } = setup(product({ canBackorder }));
      expect(screen.getByText("Out of stock")).toBeInTheDocument();
      expect(screen.queryByText("Ships when restocked")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^add/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /notify me/i }));
      expect(onToggleStockAlert).toHaveBeenCalledTimes(1);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it("an item in stock is unchanged whatever canBackorder says", () => {
    setup(product({ inStock: true, stockStatus: "IN_STOCK", canBackorder: true }));
    expect(screen.getByText("In stock")).toBeInTheDocument();
    expect(screen.queryByText("Ships when restocked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add/i })).toBeEnabled();
  });
});
