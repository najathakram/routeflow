/**
 * B1215 item 6: a product added on the ORDER-EDIT screen starts on the product's DEFAULT selling
 * unit, exactly like Create Order does (the new line carries `startOnDefaultUnit` and the row's
 * OrderLineUnitPicker moves it onto the level flagged `isDefaultSelling` once the ladder is known).
 * A line the operator already shaped (a unit, a typed qty) is never moved.
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./page";

const CASE_LEVEL = {
  id: "u1",
  label: "Case",
  factorToBase: 24,
  price: "20.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: true,
  sortOrder: 0,
};

let mockUnits: Array<Record<string, unknown>> = [CASE_LEVEL];
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({ data: mockUnits }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
const PRODUCT = {
  id: "p-cola",
  name: "Sample Cola",
  kind: "STANDARD",
  unit: "Pack",
  pricePerUnit: "30.00",
  unitsPerBox: 24,
  isActive: true,
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PRODUCT] } }),
}));

let lastItems: EditItemState[] = [];
function Harness() {
  const [items, setItems] = React.useState<EditItemState[]>([]);
  lastItems = items;
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={(item) => setItems((prev) => [...prev, item])}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 30}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
  lastItems = [];
  mockUnits = [CASE_LEVEL];
});

describe("order edit: a newly added product starts on its default unit (B1215 item 6)", () => {
  it("a picker tap lands the new line on the flagged default unit", async () => {
    renderWithProviders(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/scan barcode or type name/i), {
      target: { value: "cola" },
    });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Sample Cola/ }));
    await waitFor(() => expect(lastItems).toHaveLength(1));
    await waitFor(() => expect(lastItems[0].unitLabel).toBe("Case"));
    expect(lastItems[0].qty).toBe(1);
    expect(lastItems[0].boxSplit).toBe(false);
  });

  it("a product with no flagged default level stays on its pack", async () => {
    mockUnits = [{ ...CASE_LEVEL, isDefaultSelling: false }];
    renderWithProviders(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/scan barcode or type name/i), {
      target: { value: "cola" },
    });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Sample Cola/ }));
    await waitFor(() => expect(lastItems).toHaveLength(1));
    expect(lastItems[0].unitLabel).toBeUndefined();
  });
});
