import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductPricesGrid } from "./ProductPricesGrid";

/** K14 S1: with the old card gone, a failed price-grid load must not be a dead end. */
const refetch = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({ data: undefined, isLoading: false, isError: true, refetch }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

it("the error line has a Retry button that refetches the grid", async () => {
  render(
    <ProductPricesGrid
      product={{ id: "p1", unit: "case", unitsPerBox: 12, pricePerUnit: "1" } as never}
    />,
  );
  expect(screen.getByText("Prices could not be loaded.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalledTimes(1);
});
