import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductUnitsCard } from "./ProductUnitsCard";

let editingIn: string | null = null;
jest.mock("./units-v2/edit/PriceDraftProvider", () => ({
  ...jest.requireActual("./units-v2/edit/PriceDraftProvider"),
  usePriceDraftOptional: () => ({ editingIn, dirty: false, api: {} }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: null }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => ({ data: undefined, isLoading: true, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));

const product = {
  id: "p1",
  name: "Cola",
  unit: "case",
  unitsPerBox: 12,
  pricePerUnit: "10",
} as never;

it("v2 + inline edit: the legacy card is not rendered", () => {
  editingIn = "inline";
  renderWithProviders(<ProductUnitsCard product={product} hideAddForm readOnly />);
  expect(screen.queryByTestId("units-card-header")).toBeNull();
});
