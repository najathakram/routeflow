import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductStockCostCard, onHandLabel } from "./ProductStockCostCard";

/**
 * UX audit 2026-11-24 F56: the page header said "0 in stock · 4 oversold" while this card, on the same screen, said
 * "-4 bag". One stock number: the card now says what the header says, never a minus count.
 */
const card = (currentStock: number, product: Record<string, unknown>) =>
  render(
    <ProductStockCostCard
      product={{ id: "p1", variants: [], averageCost: "1.5", ...product }}
      stockStatus="OUT_OF_STOCK"
      currentStock={currentStock}
      onSetCost={jest.fn()}
    />,
  );

describe("Stock & Cost card: an oversold product reads like the header (F56)", () => {
  it("4 bags sold past zero reads '0 bag · 4 oversold', never '-4 bag'", () => {
    card(-4, { unit: "bag", unitsPerBox: 1 });
    expect(screen.getByText("0 bag · 4 oversold")).toBeInTheDocument();
    expect(screen.queryByText(/-4/)).toBeNull();
  });

  it("a boxed product counts in pieces: '0 pcs · 30 oversold'", () => {
    card(-30, { unit: "case", unitsPerBox: 12 });
    expect(screen.getByText("0 pcs · 30 oversold")).toBeInTheDocument();
    expect(screen.queryByText(/-30/)).toBeNull();
  });

  it("zero and a real count are unchanged", () => {
    expect(onHandLabel(0, 1, "bag")).toBe("0 bag");
    expect(onHandLabel(3, 1, "bag")).toBe("3 bag");
    expect(onHandLabel(30, 12, "case")).toBe("30 pcs (2 boxes + 6 pcs)");
    expect(onHandLabel(1500, 1, "bag")).toBe("1,500 bag");
  });

  it("groups a large oversold count and keeps a fraction", () => {
    expect(onHandLabel(-1500, 1, "bag")).toBe("0 bag · 1,500 oversold");
    expect(onHandLabel(-2.5, 1, "lb")).toBe("0 lb · 2.5 oversold");
  });
});
