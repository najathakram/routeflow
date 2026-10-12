import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProductStockCostCard } from "./ProductStockCostCard";

const product = {
  id: "p1",
  unit: "case",
  unitsPerBox: 12,
  variants: [],
  stockAlertCount: 2,
  averageCost: "1.5",
};

describe("ProductStockCostCard (extracted from the product detail page)", () => {
  it("shows stock status, on hand, waitlist, avg cost and the movements link", () => {
    render(
      <ProductStockCostCard
        product={product}
        stockStatus="LOW"
        currentStock={3}
        onSetCost={jest.fn()}
      />,
    );
    expect(screen.getByText("Stock & Cost")).toBeInTheDocument();
    expect(screen.getByText("Low Stock")).toBeInTheDocument();
    expect(screen.getByText("2 waiting for restock")).toBeInTheDocument();
    expect(screen.getByText("$1.50")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View stock movements/ })).toHaveAttribute(
      "href",
      "/inventory/movements?product=p1",
    );
  });

  it("Set cost and a missing cost basis both call onSetCost", () => {
    const onSetCost = jest.fn();
    render(
      <ProductStockCostCard
        product={{ ...product, averageCost: null }}
        stockStatus="OUT_OF_STOCK"
        currentStock={0}
        onSetCost={onSetCost}
      />,
    );
    expect(screen.getByText("0 in stock")).toBeInTheDocument(); // row 330b: the count, amber, never "Out of Stock"
    expect(screen.queryByText("Out of Stock")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set cost" }));
    fireEvent.click(screen.getByRole("button", { name: "No cost set" }));
    expect(onSetCost).toHaveBeenCalledTimes(2);
  });
});
