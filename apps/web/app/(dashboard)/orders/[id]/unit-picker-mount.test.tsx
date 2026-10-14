/**
 * A3-2: `OrderLineUnitPicker` is now mounted on the order-edit row (mirroring the
 * `CreateOrderModal` pattern — see `OrderLineUnitPicker.test.tsx` for the component's own
 * gating behavior). This pins the INTEGRATION: that the edit row actually renders it, and that
 * it (like the create-order row) renders nothing when `useUnitsEnabled()` is false or the
 * product has no ladder levels — so a tenant without `flag.units_v1` sees today's row byte for
 * byte.
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { EditableLineItems, buildItemUpdates, type EditItemState } from "./page";

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
  priceTier2: "7200.00",
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

function packLine(): EditItemState {
  return {
    id: "li-pack",
    originalProductId: "p-case",
    originalProductName: "Widget",
    originalQty: 24,
    productId: "p-case",
    productName: "Widget",
    qty: 24,
    unitPrice: 40,
    basePrice: 40,
    originalUnitPrice: 40,
    cancelled: false,
    unit: "Box",
    unitsPerBox: 24,
    boxSplit: false,
    priceType: "STANDARD",
  };
}

function renderRow(items: EditItemState[], onChange: (items: EditItemState[]) => void = () => {}) {
  return renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={onChange}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 40}
      isSpecialTierFor={() => true}
      tierForProductId={() => 2}
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

describe("setLineUnit — picking a unit sets a fresh reasonBaselinePrice (A3-2)", () => {
  it("assigns unitLabel/qty/unitPrice together and pins reasonBaselinePrice to the SAME resolved price, never the pack's", () => {
    // This customer is at a special tier (isSpecialTierFor=true, tierForProductId=2 in
    // renderRow) — exactly the case that needs a fresh baseline: without one, jumping from the
    // pack's $40 to the Case's tier-2 ladder price would look like an undocumented operator
    // override and block the save (B465's reason-required guard, needsSpecialTierReason).
    let captured: EditItemState[] = [];
    renderRow([packLine()], (items) => {
      captured = items;
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
      target: { value: "Case" },
    });
    expect(captured).toHaveLength(1);
    const updated = captured[0]!;
    expect(updated.unitLabel).toBe("Case");
    expect(updated.qty).toBe(1); // a fresh unit assignment starts at count 1, not the pack's qty
    expect(updated.boxSplit).toBe(false);
    expect(updated.overrideReason).toBeUndefined();
    // The load-bearing assertion: unitPrice IS the baseline, so a plain unit switch can never
    // read as a price change needing a reason.
    expect(updated.reasonBaselinePrice).toBe(updated.unitPrice);
    expect(updated.unitPrice).not.toBe(40); // genuinely moved off the pack's price
  });
});

describe("setLineUnit - a DERIVED Piece is the pack's pieces, not a unit line (SA P0b must 3)", () => {
  it("picks the pack-pieces shape at the pack price and sends boxes/pieces with no unitLabel", () => {
    let captured: EditItemState[] = [];
    renderRow([packLine()], (items) => {
      captured = items;
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
      target: { value: "Piece" },
    });
    const picked = captured[0]!;
    expect(picked.unitLabel).toBeUndefined();
    expect(picked.derivedBase).toBe("Piece");
    expect(picked).toMatchObject({ boxSplit: true, unitsPerBox: 24, qty: 1, unitPrice: 40 });
    expect(picked.reasonBaselinePrice).toBe(40);

    // 2 pieces of a 24-pack @ $40 is the SERVER's proration (boxes 0 / pieces 2), not 2 x a rounded per-piece price
    const orig = {
      id: "li-pack",
      productId: "p-case",
      qty: 24,
      unitPrice: "40",
      unitLabel: null,
      notes: null,
    } as never;
    const updates = buildItemUpdates([{ ...picked, qty: 2 }], [orig]);
    expect(updates).toEqual([{ id: "li-pack", action: "UPDATE", qty: 2, boxes: 0, pieces: 2 }]);
  });
});
