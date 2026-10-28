/**
 * apple-ux r5 (Edit Items at 390): jsdom has no layout, so the claims are pinned on the class tokens the CSS keys
 * off; the measured geometry is the host-run capture's job (see the PR's UI-proof checklist).
 *  - N09: the product search results are not under the pinned Save bar (the list opens ABOVE the field below sm)
 *  - F11: the Remove control shows the word "Remove" on a phone (icon-only from sm up, still named)
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const line: EditItemState = {
  id: "li-1",
  originalProductId: "p-1",
  originalProductName: "Corn Chips",
  originalQty: 3,
  productId: "p-1",
  productName: "Corn Chips",
  qty: 3,
  unitPrice: 6.99,
  basePrice: 6.99,
  originalUnitPrice: 6.99,
  cancelled: false,
  unit: "each",
  unitsPerBox: null,
  boxSplit: false,
  priceType: "STANDARD",
};

function Harness() {
  const [items, setItems] = React.useState([line]);
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 6.99}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

function PriceHarness({ boxed = false }: { boxed?: boolean }) {
  const [items, setItems] = React.useState([
    boxed ? { ...line, qty: 24, unit: "box", unitsPerBox: 12, boxSplit: true } : line,
  ]);
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 6.99}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

const tokens = (el: Element | null) =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("Edit Items product search at phone width (N09)", () => {
  it("the results list flips above the field below sm, clear of the pinned Save bar", () => {
    renderWithProviders(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/scan barcode or type name/i), {
      target: { value: "cola" },
    });
    const list = screen.getByRole("button", { name: /Sample Cola/ }).closest("ul")!.parentElement!;
    const t = tokens(list);
    expect(t).toEqual(
      expect.arrayContaining(["max-sm:bottom-full", "max-sm:top-auto", "max-sm:mb-1"]),
    );
    // from sm up it still drops below the field
    expect(t).toContain("top-full");
  });
});

// row 730: the qty and price fields of an Edit Items line are 44 px below lg (they were 36 px, h-9, everywhere).
describe("Edit Items fields are 44 px on touch widths (row 730)", () => {
  it("the qty field and both price fields step up to h-11 below lg, keeping h-9 from lg", () => {
    renderWithProviders(<PriceHarness />);
    const qty = screen.getByRole("spinbutton", { name: /qty/i });
    expect(tokens(qty)).toEqual(expect.arrayContaining(["h-9", "max-lg:h-11"]));
    for (const label of [
      ...screen.getAllByLabelText(/^unit price/i),
      ...screen.getAllByLabelText(/\$ off/i),
    ]) {
      expect(tokens(label.closest("span.rounded") as HTMLElement)).toEqual(
        expect.arrayContaining(["h-9", "max-lg:h-11"]),
      );
    }
  });

  it("a boxed line's cases and pieces fields use the same 44 px step", () => {
    renderWithProviders(<PriceHarness boxed />);
    expect(tokens(screen.getByTitle(/number of whole/i))).toEqual(
      expect.arrayContaining(["h-9", "max-lg:h-11"]),
    );
  });
});

describe("Edit Items Remove control at phone width (F11)", () => {
  it("shows the word Remove next to the icon below sm, and stays named for assistive tech", () => {
    renderWithProviders(<Harness />);
    const remove = screen.getByRole("button", { name: "Remove Corn Chips" });
    const word = Array.from(remove.querySelectorAll("span")).find(
      (s) => s.textContent?.trim() === "Remove",
    );
    expect(word).toBeDefined();
    // visible on a phone: it may only be screen-reader-only from sm up, never unconditionally
    expect(tokens(word!)).not.toContain("sr-only");
    expect(tokens(word!)).toContain("sm:sr-only");
    expect(remove.querySelector("svg")).not.toBeNull();
  });
});
