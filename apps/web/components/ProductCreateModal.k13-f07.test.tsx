import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/** K13 F07: picking a boxed Unit closes the suggestion list and shows Units per box beside the price. */
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

it("closes the Unit list on a pick and shows Units per box in the same row", async () => {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  await userEvent.click(screen.getByLabelText(/^Unit \*/));
  fireEvent.mouseDown(screen.getByRole("button", { name: "case" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByLabelText(/^Units per/)).toBeInTheDocument();
});
