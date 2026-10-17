import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getStoredUser } from "@/lib/auth";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { draftKey, EMPTY_DRAFT_FORM } from "./product-create/product-create-draft";

/**
 * K11-26: the New product dialog, finished. Flag on and off alike (the dialog never reads a flag).
 *   FE1  Escape closes a pristine dialog; once dirty it does nothing, as before
 *   P18  "New product" / "Create product" (sentence case)
 *   P19  focus lands on Name (Flavor when a parent is set), not on the X
 *   P17  Barcode has its own scan button, wired to Barcode, not SKU
 *   P20  the scroll body keeps room under its last field for an open list and the footer
 *   A5   the unit code helper reads "Printed on invoices. Leave blank if it's the same as the box code."
 */
const mutateAsync = jest.fn();
let products: { data: unknown[] } = { data: [] };

jest.mock("@/lib/auth", () => ({
  ...jest.requireActual("@/lib/auth"),
  getStoredUser: jest.fn(),
}));
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: products }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
// The scanner stub reports a fixed code through whichever field it was handed to.
jest.mock("./BarcodeScannerButton", () => ({
  BarcodeScannerButton: ({ title, onScan }: { title?: string; onScan: (c: string) => void }) => (
    <button type="button" aria-label={title} onClick={() => onScan("CODE-9")} />
  ),
}));

function open(props: Partial<React.ComponentProps<typeof ProductCreateModal>> = {}) {
  const onClose = jest.fn();
  const utils = renderWithProviders(
    <ProductCreateModal isOpen onClose={onClose} onCreated={jest.fn()} {...props} />,
  );
  return { onClose, ...utils };
}
const esc = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

beforeEach(() => {
  localStorage.clear();
  (getStoredUser as jest.Mock).mockReset();
  (getStoredUser as jest.Mock).mockReturnValue(null);
  mutateAsync.mockReset();
  products = { data: [] };
});

describe("K11-26: names", () => {
  it("the dialog is named 'New product' and its button 'Create product'", () => {
    open();
    expect(screen.getByRole("dialog", { name: "New product" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create product" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Product" })).toBeNull();
  });
});

describe("K11-26: Escape closes only a pristine dialog", () => {
  it("closes when nothing has been typed", () => {
    const { onClose } = open();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing once a field has been typed in", async () => {
    const { onClose } = open();
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes again if the typed text is erased (the form equals the blank form again)", async () => {
    const { onClose } = open();
    await userEvent.type(screen.getByLabelText("Name *"), "C");
    await userEvent.clear(screen.getByLabelText("Name *"));
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a photo is queued", async () => {
    const { onClose } = open();
    const file = new File(["x"], "cola.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an untouched prefilled dialog (opened from a scanned line) is pristine; editing the prefill makes it dirty", async () => {
    const { onClose } = open({ initialName: "ACME COLA 24PK", initialPrice: 26 });
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await userEvent.type(screen.getByLabelText("Name *"), "!");
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a restored draft is the new baseline: Escape closes until the operator changes it", async () => {
    (getStoredUser as jest.Mock).mockReturnValue({ id: "user-a", tenantSlug: "acme" });
    localStorage.setItem(
      draftKey()!,
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        fields: { ...EMPTY_DRAFT_FORM, name: "Cola", pricePerUnit: "12.00" },
      }),
    );
    const { onClose } = open();
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    expect(screen.getByLabelText("Name *")).toHaveValue("Cola");
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await userEvent.type(screen.getByLabelText("Name *"), "s");
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape meant for an open Unit list closes the list, not the dialog", async () => {
    const { onClose } = open();
    await userEvent.click(screen.getByLabelText(/^Unit \*/));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(/^Unit \*/), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an outside click still never closes it (only X, Cancel and a pristine Escape do)", async () => {
    const { onClose } = open();
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("K11-26: focus lands on the first thing to type", () => {
  it("on open, focus is on Name (not the X)", () => {
    open();
    expect(document.activeElement).toBe(document.getElementById("product-name"));
  });

  it("with a parent already chosen, focus is on Flavor / variety", async () => {
    products = { data: [{ id: "par1", name: "Acme", unit: "box", pricePerUnit: "1.00" }] };
    open({ defaultParentId: "par1" });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Chocolate/));
  });
});

describe("K11-26: Barcode gets its own scan button", () => {
  it("scanning into Barcode fills Barcode and leaves SKU alone", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Scan barcode" }));
    expect(screen.getByLabelText("Barcode")).toHaveValue("CODE-9");
    expect(screen.getByLabelText("SKU (box code)")).toHaveValue("");
  });

  it("the SKU scan button still fills SKU only", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Scan SKU" }));
    expect(screen.getByLabelText("SKU (box code)")).toHaveValue("CODE-9");
    expect(screen.getByLabelText("Barcode")).toHaveValue("");
  });
});

describe("K11-26: layout and copy", () => {
  it("the scroll body keeps room under its last field (at least the footer's height)", () => {
    open();
    const form = document.getElementById("product-create-form") as HTMLElement;
    expect(form.className).toMatch(/\bpb-(20|24|28|32)\b/);
  });

  it("the unit code helper is the short invoice sentence", () => {
    open();
    expect(
      screen.getByText("Printed on invoices. Leave blank if it's the same as the box code."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Code on the individual unit/)).toBeNull();
  });
});
