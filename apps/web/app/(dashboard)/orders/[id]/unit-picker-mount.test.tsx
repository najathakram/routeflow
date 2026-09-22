/**
 * A3-2: `OrderLineUnitPicker` is now mounted on the order-edit row (mirroring the
 * `CreateOrderModal` pattern — see `OrderLineUnitPicker.test.tsx` for the component's own
 * gating behavior). This pins the INTEGRATION: that the edit row actually renders it, and that
 * it (like the create-order row) renders nothing when `useUnitsEnabled()` is false or the
 * product has no ladder levels — so a tenant without `flag.units_v1` sees today's row byte for
 * byte.
 */
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./page";

let mockEnabled = true;
let mockUnits: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => mockEnabled,
  useProductUnits: () => ({ data: mockUnits }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

const CASE_LEVEL = {
  id: "u1",
  label: "Case",
  factorToBase: 192,
  price: "7680.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
};

function caseLine(): EditItemState {
  return {
    id: "li-case",
    originalProductId: "p-case",
    originalProductName: "Widget",
    originalQty: 3,
    productId: "p-case",
    productName: "Widget",
    qty: 3,
    unitPrice: 40,
    basePrice: 40,
    cancelled: false,
    unit: "Box",
    unitsPerBox: 192,
    boxSplit: false,
    unitLabel: "Case",
    priceType: "STANDARD",
  };
}

function renderRow(items: EditItemState[]) {
  return renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={() => {}}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 40}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );
}

beforeEach(() => {
  mockEnabled = true;
  mockUnits = [CASE_LEVEL];
});

describe("EditableLineItems mounts OrderLineUnitPicker on the edit row (A3-2, c)", () => {
  it("renders the unit picker when useUnitsEnabled() is true and the product has levels", () => {
    renderRow([caseLine()]);
    expect(screen.getByRole("combobox", { name: /Sell Widget by/i })).toBeInTheDocument();
  });

  it("renders nothing extra when useUnitsEnabled() is false", () => {
    mockEnabled = false;
    // Mirrors `useProductUnits`'s real `enabled` gate (never fetches -> `data` stays undefined) —
    // the mock below doesn't read the enabled arg itself, same convention as
    // `OrderLineUnitPicker.test.tsx`'s own "lacks flag.units_v1" case.
    mockUnits = undefined as unknown as Array<Record<string, unknown>>;
    renderRow([caseLine()]);
    expect(screen.queryByRole("combobox", { name: /Sell Widget by/i })).not.toBeInTheDocument();
  });

  it("renders nothing when the product has no ladder levels", () => {
    mockUnits = [];
    renderRow([caseLine()]);
    expect(screen.queryByRole("combobox", { name: /Sell Widget by/i })).not.toBeInTheDocument();
  });
});
