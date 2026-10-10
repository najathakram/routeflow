/**
 * #2715 PR-1 — the draft-order EDIT page gets the create flow's scanner and a one-card line:
 *   - the shared BarcodeScannerButton (camera + USB wedge) on the add-item field, wired to the same
 *     resolve ladder the Enter path uses;
 *   - the field's own Enter handler stands down when the button's wedge detector already handled a
 *     scan (`e.defaultPrevented`, the #2704 / *.wedge-scan-race pattern), so ONE physical scan adds
 *     ONE product — the REAL button is rendered here, never mocked;
 *   - the WHOLE line (row + price-edit row + note) sits in ONE bordered card.
 * No payload change: the PATCH path (useUpdateOrderItems) is untouched.
 */
import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./page";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));
const resolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (code: string) => resolveProductByCode(code),
}));

const SCANNED = {
  id: "p-new",
  name: "Scanned Cola",
  pricePerUnit: "5",
  unit: "can",
  unitsPerBox: null,
  isActive: true,
};

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
function renderEditor(canEditPrice = false) {
  onAdd = jest.fn();
  return renderWithProviders(
    <EditableLineItems
      items={[line()]}
      onChange={() => {}}
      onAdd={onAdd}
      onDelete={() => {}}
      canEditPrice={canEditPrice}
      tierPriceFor={() => 5}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );
}

let dateNowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  resolveProductByCode.mockReset();
  resolveProductByCode.mockResolvedValue({ product: SCANNED, source: "barcode" });
  let t = 1_700_000_000_000;
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t += 10));
});
afterEach(() => dateNowSpy.mockRestore());

function wedgeScan(input: HTMLElement, code: string) {
  for (const ch of code) fireEvent.keyDown(input, { key: ch });
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("#2715 PR-1 — draft-order edit: the create flow's scanner", () => {
  it("the add-item field has the shared camera/wedge scanner button", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: /scan barcode/i })).toBeInTheDocument();
  });

  it("one physical wedge scan adds the product ONCE (the Enter handler stands down)", async () => {
    renderEditor();
    const input = screen.getByPlaceholderText(/scan barcode or type name/i);
    await act(async () => {
      wedgeScan(input, "0123456789012");
    });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(resolveProductByCode).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("#2715 PR-1 — one bordered card per line", () => {
  it("the line's price-edit row sits INSIDE the line's bordered card (not a bare sibling)", () => {
    renderEditor(true);
    const card = screen.getByText("Widget").closest(".rounded-lg.border");
    expect(card).not.toBeNull();
    expect(card).toContainElement(screen.getAllByText(/unit price/i)[0]);
  });
});
