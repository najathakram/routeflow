import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductPricesGrid } from "./ProductPricesGrid";

/** K14 FE1: while the grid loads it holds its final height, so nothing below it moves when the prices arrive. */
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({ data: undefined, isLoading: true, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

const product = (unitsPerBox: number | null) =>
  ({ id: "p1", unit: "case", unitsPerBox, pricePerUnit: "10" }) as never;

const rows = (kind: "card" | "table") =>
  document.querySelectorAll(`[data-testid="prices-skeleton-${kind}"]`).length;

it("renders a card placeholder and a table-row placeholder per unit (pack + piece = 2)", () => {
  render(<ProductPricesGrid product={product(24)} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading prices");
  expect(rows("card")).toBe(2);
  expect(rows("table")).toBe(2);
});

it("a product with no pack renders one", () => {
  render(<ProductPricesGrid product={product(null)} />);
  expect(rows("card")).toBe(1);
  expect(rows("table")).toBe(1);
});
