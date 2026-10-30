/**
 * SA-1044 A-2 at the editor: the picker's `held` factor is the line's raw stored `unitsPerBox` (`heldUnitsPerBox`), never the
 * pack size and never the pack-fallback `originalUnitsPerBox`. Each case has a null-stored companion line, because the
 * fallback only differs from the raw value when the stored size is null. Harness: page.price-layer-picker.test.tsx.
 */
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";

const caseRow = (factorToBase: number) => ({
  id: `u-${factorToBase}`,
  label: "Case",
  factorToBase,
  price: "60.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
});
const mockLadders: Record<string, unknown[]> = {};
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: (id: string) => ({ data: mockLadders[id] }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

// A Case line on a Box-of-12 product, as buildEditItemFromLine loads it: stored size `stored` (null = unknown).
const caseLine = (id: string, name: string, stored: number | null): EditItemState => ({
  id,
  originalProductId: `p-${id}`,
  originalProductName: name,
  originalQty: 2,
  productId: `p-${id}`,
  productName: name,
  qty: 2,
  unitPrice: 55,
  basePrice: 55,
  originalUnitPrice: 55,
  originalBasePrice: 55,
  cancelled: false,
  unit: "Case",
  unitsPerBox: stored ?? 12,
  packUnit: "Box",
  packUnitsPerBox: 12,
  unitLabel: "Case",
  originalUnitLabel: "Case",
  heldUnitsPerBox: stored,
  originalUnitsPerBox: stored ?? 12,
  boxSplit: false,
  priceType: "STANDARD",
});

const renderRows = (items: EditItemState[], onChange: jest.Mock) =>
  renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={onChange}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 30}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );

const optionTexts = (name: string) =>
  Array.from(
    (
      screen.getByRole("combobox", {
        name: new RegExp(`Sell ${name} by`, "i"),
      }) as HTMLSelectElement
    ).options,
  ).map((o) => o.textContent ?? "");

// Every price the editor wrote to a line through onChange (the #2305 refresh writes the ladder's 60).
const pricesWritten = (onChange: jest.Mock, id: string) =>
  onChange.mock.calls.flatMap((c) =>
    (c[0] as EditItemState[]).filter((it) => it.id === id).map((it) => it.unitPrice),
  );

beforeEach(() => {
  for (const k of Object.keys(mockLadders)) delete mockLadders[k];
});

describe("order line edit: the held factor is the stored size", () => {
  it("(a) a live non-pack level stays live and the #2305 refresh fires", () => {
    mockLadders["p-li-live"] = [caseRow(24)]; // stored 24, ladder Case 24: live
    mockLadders["p-li-null"] = [caseRow(24)]; // stored null: unknown, never resized
    const onChange = jest.fn();
    renderRows([caseLine("li-live", "Alpha", 24), caseLine("li-null", "Bravo", null)], onChange);
    expect(optionTexts("Alpha").some((t) => t.includes("(as ordered)"))).toBe(false);
    expect(optionTexts("Bravo").some((t) => t.includes("(as ordered)"))).toBe(false);
    expect(pricesWritten(onChange, "li-live")).toContain(60);
    expect(pricesWritten(onChange, "li-null")).toContain(60);
  });

  it("(b) a level resized to the pack size reads resized", () => {
    mockLadders["p-li-resized"] = [caseRow(12)]; // stored 24, ladder Case now 12 = the pack size
    mockLadders["p-li-null"] = [caseRow(30)]; // stored null: unknown, so no snapshot option
    const onChange = jest.fn();
    renderRows(
      [caseLine("li-resized", "Charlie", 24), caseLine("li-null", "Delta", null)],
      onChange,
    );
    expect(optionTexts("Charlie").some((t) => t.includes("(as ordered)"))).toBe(true);
    expect(pricesWritten(onChange, "li-resized")).not.toContain(60);
    expect(optionTexts("Delta").some((t) => t.includes("(as ordered)"))).toBe(false);
    expect(pricesWritten(onChange, "li-null")).toContain(60);
  });
});
