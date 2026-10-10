/**
 * B1215 C7 on the order-edit screen: neither the add-item dropdown nor the Substitute picker may
 * offer a FAMILY as a line. A family's variants stand in for it, named "<Parent> - <Variant>".
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./page";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  pricePerUnit: "4.00",
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [MINT],
};
const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  kind: "STANDARD",
  unit: "each",
  pricePerUnit: "2.00",
  isActive: true,
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [FAMILY, COLA] } }),
}));

function line(): EditItemState {
  return {
    id: "li-1",
    originalProductId: "p1",
    originalProductName: "Widget",
    originalQty: 2,
    productId: "p1",
    productName: "Widget",
    qty: 2,
    unitPrice: 10,
    basePrice: 10,
    originalUnitPrice: 10,
    cancelled: false,
    unit: "each",
    unitsPerBox: null,
    boxSplit: false,
    priceType: "STANDARD",
  } as EditItemState;
}

let onAdd: jest.Mock;
let onChange: jest.Mock;
function renderEditor() {
  onAdd = jest.fn();
  onChange = jest.fn();
  return renderWithProviders(
    <EditableLineItems
      items={[line()]}
      onChange={onChange}
      onAdd={onAdd}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 4}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

describe("order edit add-item dropdown (B1215 C7)", () => {
  it("offers the family's variant under the parent name, never the family itself", async () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText(/scan barcode or type name/i), {
      target: { value: "pod" },
    });
    expect(await screen.findByRole("button", { name: /Sample Pod - Mint/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sample Pod\b(?! -)/ })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: /Sample Pod - Mint/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0][0]).toEqual(
      expect.objectContaining({ productId: "v-mint", productName: "Sample Pod - Mint" }),
    );
  });
});

describe("order edit Substitute picker (B1215 C7)", () => {
  it("offers the variant under the parent name and substitutes with it, never the family", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Substitute" }));
    fireEvent.change(screen.getByPlaceholderText("Search products..."), {
      target: { value: "pod" },
    });
    const option = await screen.findByRole("button", { name: /Sample Pod - Mint/ });
    expect(screen.queryByRole("button", { name: /^Sample Pod\b(?! -)/ })).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0][0];
    expect(next).toEqual(
      expect.objectContaining({
        substituteProductId: "v-mint",
        productId: "v-mint",
        productName: "Sample Pod - Mint",
      }),
    );
  });
});
