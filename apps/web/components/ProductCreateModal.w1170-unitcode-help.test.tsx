import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * W-1170 P24: at 390 px the scrolled form showed "Printed on invoices..." at the top with its Unit code field scrolled
 * away. Under v2 the helper is visible only while its field is focused (so it is never on screen without it) and stays
 * available to screen readers through aria-describedby. Flag off keeps today's always-visible line.
 */
const flags = { v2: true };
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flags.v2 }));
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

const open = () =>
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
const help = () => screen.getByText(/Printed on invoices\./);

describe("W-1170 P24: Unit code helper stays with its field", () => {
  it("v2: not shown on screen until the Unit code field is focused, always described to screen readers", () => {
    flags.v2 = true;
    open();
    const field = screen.getByLabelText("Unit code");
    expect(help()).toHaveClass("sr-only");
    expect(field.getAttribute("aria-describedby")).toBe(help().id);
    fireEvent.focus(field);
    expect(help()).not.toHaveClass("sr-only");
    fireEvent.blur(field);
    expect(help()).toHaveClass("sr-only");
  });

  it("flag off: unchanged, the line is always visible", () => {
    flags.v2 = false;
    open();
    expect(help()).not.toHaveClass("sr-only");
  });
});
