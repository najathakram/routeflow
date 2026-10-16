import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { uploadProductImages } from "@/lib/api/products";

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

  it("does not close on Escape or an outside click; the X still closes", async () => {
    const onClose = jest.fn();
    renderWithProviders(<ProductCreateModal isOpen onClose={onClose} onCreated={jest.fn()} />);
    await new Promise((r) => setTimeout(r, 20)); // Radix arms outside-click on a timer
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it("a photo upload that fails AFTER the product was created says so, and the product is still handed back", async () => {
    (uploadProductImages as jest.Mock).mockRejectedValueOnce(new Error("500"));
    const onCreated = jest.fn();
    const onClose = jest.fn();
    const { container } = renderWithProviders(
      <ProductCreateModal isOpen onClose={onClose} onCreated={onCreated} />,
    );
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
    await userEvent.type(screen.getByLabelText("Price per box *"), "12");
    const file = new File(["x"], "cola.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(container).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Create Product" }));
    expect(
      await screen.findByText("Product created, but its photos didn't upload"),
    ).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ProductCreateModal price-as-quantity hint (V09)", () => {
  async function fill(unit: string, unitsPerBox: string, price: string) {
    open();
    await userEvent.type(screen.getByLabelText(/^Unit \*/), unit);
    if (unitsPerBox) await userEvent.type(screen.getByLabelText("Units per box"), unitsPerBox);
    await userEvent.type(screen.getByLabelText(/^Price per /), price);
  }

  it("asks when the price equals the box count", async () => {
    await fill("box", "12", "12");
    const hint = document.getElementById("price-qty-hint");
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute("aria-live", "polite");
    expect(hint).toHaveTextContent("A box holds 12. Is $12.00 the price for the whole box?");
    expect(screen.getByLabelText("Price per box *")).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("price-qty-hint"),
    );
  });

  it("does not show for 12.50", async () => {
    await fill("box", "12", "12.50");
    expect(document.getElementById("price-qty-hint")).toBeEmptyDOMElement();
    expect(screen.getByLabelText("Price per box *")).not.toHaveAttribute("aria-describedby");
  });

  it("does not show when units per box is 1", async () => {
    await fill("box", "1", "1");
    expect(document.getElementById("price-qty-hint")).toBeEmptyDOMElement();
  });

  it("keeps the live region mounted but empty until it applies", async () => {
    await fill("box", "", "12");
    const hint = document.getElementById("price-qty-hint");
    expect(hint).not.toBeNull();
    expect(hint).toBeEmptyDOMElement();
  });

  it("does not block saving", async () => {
    await fill("box", "12", "12");
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    fireEvent.click(screen.getByRole("button", { name: "Create Product" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  });
});

describe("ProductCreateModal unit field fast typing (V01)", () => {
  it("typing 'Can' quickly lands whole in the unit field and nowhere else", async () => {
    open();
    const unit = screen.getByLabelText(/^Unit \*/) as HTMLInputElement;
    await userEvent.type(unit, "Can");
    expect(unit).toHaveValue("Can");
    for (const label of ["Name *", "Barcode", "Unit code", "SKU (box code)"]) {
      expect(screen.getByLabelText(label)).toHaveValue("");
    }
    expect(screen.queryByText(/new unit/i)).toBeNull();
  });
});
