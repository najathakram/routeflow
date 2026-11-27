/**
 * SA-1506 PR-1a: an admin's CORRECTABLE delivered line keeps its quantity input and price editor, shows the correction
 * note, offers no Substitute / Not available, and Remove asks "Take off" / "Keep" first. A LOCKED line shows the server's
 * sentence (its reason), not the old one.
 */
import * as React from "react";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";

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
jest.mock("@/components/OrderLineUnitPicker", () => ({
  OrderLineUnitPicker: () => <div data-testid="unit-picker" />,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

const line = (over: Partial<EditItemState> = {}): EditItemState => ({
  id: "li-1",
  originalProductId: "p-1",
  originalProductName: "Widget",
  originalQty: 3,
  productId: "p-1",
  productName: "Widget",
  qty: 3,
  unitPrice: 10,
  basePrice: 10,
  originalUnitPrice: 10,
  cancelled: false,
  unit: "each",
  unitsPerBox: null,
  boxSplit: false,
  priceType: "STANDARD",
  ...over,
});

function render(items: EditItemState[], onDelete = jest.fn(), locked?: ReadonlySet<string>) {
  renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={() => {}}
      onAdd={() => {}}
      onDelete={onDelete}
      canEditPrice
      tierPriceFor={() => 10}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
      lockedLineIds={locked}
    />,
  );
  return onDelete;
}

describe("a correctable delivered line (admin)", () => {
  const correctable = line({
    id: "c1",
    productName: "Delivered Widget",
    correctable: true,
    deliveredNote: 3,
  });

  it("keeps its controls, shows the note, and has no Substitute or Not available", () => {
    render([correctable]);
    expect(screen.getByTestId("correctable-note").textContent).toBe(
      "Delivered: 3 each. Changing this corrects what was delivered. Stock and the invoice update. If goods came back, use Return.",
    );
    expect(screen.queryByText("Substitute")).toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
    expect(screen.getByRole("spinbutton")).toBeTruthy();
  });

  it("Remove asks first: Keep leaves the line, Take off removes it", () => {
    const onDelete = render([correctable]);
    fireEvent.click(screen.getByRole("button", { name: /Remove Delivered Widget/ }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Take Delivered Widget off this order?")).toBeTruthy();
    fireEvent.click(screen.getByText("Keep"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Take Delivered Widget off this order?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remove Delivered Widget/ }));
    fireEvent.click(screen.getByText("Take off"));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("an ordinary line removes at once, no confirm", () => {
    const onDelete = render([line({ id: "o1", productName: "Open Widget" })]);
    fireEvent.click(screen.getByRole("button", { name: /Remove Open Widget/ }));
    expect(onDelete).toHaveBeenCalledWith("o1");
  });
});

describe("a locked delivered line shows the server's reason", () => {
  it("renders the line's own sentence", () => {
    render(
      [line({ id: "l1", lockedHint: "Reopen the order to correct delivered items." })],
      jest.fn(),
      new Set(["l1"]),
    );
    expect(screen.getByText("Reopen the order to correct delivered items.")).toBeTruthy();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});
