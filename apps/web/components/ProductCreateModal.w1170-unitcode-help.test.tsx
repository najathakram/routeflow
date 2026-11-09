import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * W-1170 P24: the Unit code helper ("Printed on invoices...") belongs to its field. It is always visible, directly
 * under the field in the same wrapper (so it can never be a line with no field), is linked with aria-describedby,
 * and does NOT appear or disappear on focus (that moved the rows below by 18-34 px).
 */
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
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

it("keeps the helper visible, in the field's own wrapper, and described-by, with or without focus", () => {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  const field = screen.getByLabelText("Unit code");
  const help = screen.getByText(/Printed on invoices\./);
  expect(help).not.toHaveClass("sr-only");
  expect(help.closest("div.col-span-2")).toContainElement(field);
  expect(field.getAttribute("aria-describedby")).toBe(help.id);
  const before = help.className;
  fireEvent.focus(field);
  expect(help.className).toBe(before);
  fireEvent.blur(field);
  expect(help.className).toBe(before);
});
