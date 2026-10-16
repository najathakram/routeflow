import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductStockCostCard } from "./ProductStockCostCard";

const product = {
  id: "p1",
  unit: "case",
  unitsPerBox: 12,
  variants: [{ id: "v1" }],
  stockAlertCount: 2,
  averageCost: "1.5",
};

function renderCard(pricesV2?: boolean) {
  return render(
    <ProductStockCostCard
      product={product}
      stockStatus="LOW"
      currentStock={3}
      onSetCost={jest.fn()}
      pricesV2={pricesV2}
    />,
  );
}

describe("ProductStockCostCard with pricesV2 (T36)", () => {
  it("drops the on hand, not-yet-split and waitlist rows", () => {
    renderCard(true);
    expect(screen.queryByText(/On hand/)).toBeNull();
    expect(screen.queryByText("Not yet split to variants")).toBeNull();
    expect(screen.queryByText("Waitlist")).toBeNull();
    expect(screen.queryByText("2 waiting for restock")).toBeNull();
  });

  it("keeps the cost, the set-cost action and the movements link", () => {
    renderCard(true);
    expect(screen.getByText("Stock & Cost")).toBeInTheDocument();
    expect(screen.getByText("Avg cost")).toBeInTheDocument();
    expect(screen.getByText("$1.50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set cost" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View stock movements/ })).toBeInTheDocument();
  });

  it("with the prop absent the rows are all still there", () => {
    renderCard();
    expect(screen.getByText(/On hand/)).toBeInTheDocument();
    expect(screen.getByText("Not yet split to variants")).toBeInTheDocument();
    expect(screen.getByText("2 waiting for restock")).toBeInTheDocument();
  });
});
