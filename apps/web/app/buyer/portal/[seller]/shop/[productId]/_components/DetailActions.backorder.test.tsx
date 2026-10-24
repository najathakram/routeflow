import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BuyerProductDetail } from "@/lib/api/buyer";
import { DetailActions } from "./DetailActions";

/**
 * OOS PR2 (R3c): the product page uses the same rule as the tile (one helper): out of stock +
 * canBackorder = "Add to cart" and "Ships when restocked"; otherwise Notify me, as before.
 */
const detail = (over: Partial<BuyerProductDetail> = {}): BuyerProductDetail =>
  ({
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
    imageUrls: [],
    variants: [],
    isFeatured: false,
    isNew: false,
    isDeal: false,
    inStock: false,
    stockStatus: "OUT_OF_STOCK",
    stockLeft: null,
    ...over,
  }) as BuyerProductDetail;

function setup(p: BuyerProductDetail) {
  const onAdd = jest.fn();
  const onToggleStockAlert = jest.fn();
  render(
    <DetailActions
      product={p}
      cartItem={undefined}
      promoRules={[]}
      promotions={[]}
      onAdd={onAdd}
      onUpdateQty={jest.fn()}
      isAlertSubscribed={false}
      onToggleStockAlert={onToggleStockAlert}
    />,
  );
  return { onAdd, onToggleStockAlert };
}

describe("DetailActions — out of stock", () => {
  it("canBackorder: 'Add to cart' + the 'Ships when restocked' note, no Notify me", () => {
    const { onAdd } = setup(detail({ canBackorder: true }));
    expect(screen.getByTestId("ships-when-restocked")).toHaveTextContent("Ships when restocked");
    expect(screen.queryByRole("button", { name: /notify me/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("product-detail-add"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it.each([[false], [undefined]])(
    "canBackorder %p: Notify me and no Add, no note (unchanged)",
    (canBackorder) => {
      const { onAdd, onToggleStockAlert } = setup(detail({ canBackorder }));
      expect(screen.queryByTestId("ships-when-restocked")).not.toBeInTheDocument();
      expect(screen.queryByTestId("product-detail-add")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /notify me/i }));
      expect(onToggleStockAlert).toHaveBeenCalledTimes(1);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it("in stock: Add to cart, no note", () => {
    setup(detail({ inStock: true, stockStatus: "IN_STOCK", canBackorder: true }));
    expect(screen.getByTestId("product-detail-add")).toBeInTheDocument();
    expect(screen.queryByTestId("ships-when-restocked")).not.toBeInTheDocument();
  });
});
