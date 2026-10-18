/**
 * B1234 (D-O2-a): in the order edit builder a DELIVERED line of a PARTIALLY_DELIVERED order offers no control
 * the API will refuse: no quantity input, no unit picker, no price editor, no Substitute / Not available /
 * Delete. A note stays editable. Undelivered lines of the same order keep every control. The page hands the
 * builder `lockedLineIds` from the one predicate in lib/order-line-lock.ts.
 */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderWithProviders, screen, within } from "@/test-utils/render";
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
// A stand-in so the unit control's presence is observable without the units_v1 query layer.
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

const DELIVERED = line({ id: "li-del", productName: "Delivered Widget" });
const OPEN = line({ id: "li-open", productId: "p-2", productName: "Open Widget" });

function renderRows(lockedLineIds?: ReadonlySet<string>) {
  return renderWithProviders(
    <EditableLineItems
      items={[DELIVERED, OPEN]}
      onChange={() => {}}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 10}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
      lockedLineIds={lockedLineIds}
    />,
  );
}

/** The bordered card of one line, found by its product name. */
function card(name: string): HTMLElement {
  const el = screen.getByText(name).closest("div.rounded-lg");
  if (!el) throw new Error(`no card for ${name}`);
  return el as HTMLElement;
}

describe("order edit builder: delivered lines are locked (B1234)", () => {
  it("a locked line has no qty input, no price editor, no Substitute, no Not available and no Delete", () => {
    renderRows(new Set(["li-del"]));
    const c = within(card("Delivered Widget"));
    expect(c.queryByRole("spinbutton")).toBeNull(); // the Qty input
    expect(c.queryByText(/^substitute$/i)).toBeNull();
    expect(c.queryByText(/not available/i)).toBeNull();
    expect(c.queryByTitle("Delete item")).toBeNull();
    expect(c.queryByText(/unit price/i)).toBeNull(); // PriceEditRow
    expect(c.getByText(/delivered\. this line can't be changed or removed/i)).toBeTruthy();
  });

  it("a locked line has no unit picker; the undelivered line keeps it", () => {
    renderRows(new Set(["li-del"]));
    expect(within(card("Delivered Widget")).queryByTestId("unit-picker")).toBeNull();
    expect(within(card("Open Widget")).getByTestId("unit-picker")).toBeTruthy();
  });

  it("a locked classic boxed line has no cases / loose-pieces inputs either (master's boxed control)", () => {
    const boxed = (over: Partial<EditItemState>) =>
      line({ unitsPerBox: 12, unit: "case", boxSplit: true, qty: 26, ...over });
    renderWithProviders(
      <EditableLineItems
        items={[
          boxed({ id: "li-del", productName: "Delivered Widget" }),
          boxed({ id: "li-open", productId: "p-2", productName: "Open Widget" }),
        ]}
        onChange={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        canEditPrice
        tierPriceFor={() => 10}
        isSpecialTierFor={() => false}
        tierForProductId={() => 1}
        pricingReady
        lockedLineIds={new Set(["li-del"])}
      />,
    );
    expect(within(card("Delivered Widget")).queryAllByRole("spinbutton")).toHaveLength(0);
    expect(within(card("Open Widget")).queryAllByRole("spinbutton").length).toBeGreaterThan(0);
  });

  it("a locked line still takes a note", () => {
    renderRows(new Set(["li-del"]));
    expect(
      within(card("Delivered Widget")).getByPlaceholderText(/note for this line/i),
    ).toBeTruthy();
  });

  it("the undelivered line of the same order keeps every control", () => {
    renderRows(new Set(["li-del"]));
    const c = within(card("Open Widget"));
    expect(c.getByRole("spinbutton")).toBeTruthy();
    expect(c.getByText(/^substitute$/i)).toBeTruthy();
    expect(c.getByText(/not available/i)).toBeTruthy();
    expect(c.getByTitle("Delete item")).toBeTruthy();
    expect(c.queryByText(/delivered\. this line can't/i)).toBeNull();
  });

  it("with no locked ids (every other status) both lines keep every control", () => {
    renderRows(undefined);
    for (const name of ["Delivered Widget", "Open Widget"]) {
      const c = within(card(name));
      expect(c.getByRole("spinbutton")).toBeTruthy();
      expect(c.getByTitle("Delete item")).toBeTruthy();
    }
  });
});

describe("order page wiring", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
  it("hands the builder the ids from the one predicate, keyed on the order's own status and lines", () => {
    expect(src).toContain("deliveredLockedLineIds(");
    expect(src).toMatch(/lockedLineIds=\{/);
  });
});
