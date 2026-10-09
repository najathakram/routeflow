import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

const mutateAsync = jest.fn();

jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

function open() {
  return renderWithProviders(
    <ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />,
  );
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
});

describe("ProductCreateModal (web-2 #5)", () => {
  it("prices per the unit the operator typed, with Units per box next to it", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
    const price = screen.getByLabelText("Price per box *");
    const units = screen.getByLabelText("Units per box");
    expect(price.closest("[data-price-row]")).not.toBeNull();
    expect(price.closest("[data-price-row]")).toBe(units.closest("[data-price-row]"));
  });

  it("falls back to 'Price per unit' until a unit is chosen", () => {
    open();
    expect(screen.getByLabelText("Price per unit *")).toBeInTheDocument();
  });

  it("labels the codes: Barcode, SKU (box code), Unit code", () => {
    open();
    expect(screen.getByLabelText("Barcode")).toBeInTheDocument();
    expect(screen.getByLabelText("SKU (box code)")).toBeInTheDocument();
    expect(screen.getByLabelText("Unit code")).toBeInTheDocument();
    expect(screen.queryByText(/code \(SKU \/ barcode\)/)).toBeNull();
  });

  it("sends barcode in the POST body", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    await userEvent.type(screen.getByLabelText("Barcode"), "0123456789012");
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
    await userEvent.type(screen.getByLabelText("Price per box *"), "12");
    fireEvent.click(screen.getByRole("button", { name: "Create Product" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toEqual(
      expect.objectContaining({ barcode: "0123456789012" }),
    );
  });

  it("pins Create in the shared Modal footer slot (header and footer stay put)", () => {
    open();
    const dialog = screen.getByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create Product" });
    const scrollBody = dialog.querySelector(".overflow-y-auto");
    expect(scrollBody).not.toBeNull();
    // footer is a sibling of the scrolling body, never inside it
    expect(scrollBody!.contains(create)).toBe(false);
    expect(create.closest(".shrink-0")).not.toBeNull();
    // and it still submits the form that lives in the body
    expect(create).toHaveAttribute("form");
    expect(document.getElementById(create.getAttribute("form")!)).not.toBeNull();
  });
});
