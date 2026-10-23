/**
 * apple-ux r4 PR-GH (Q28, Q29, Q30): one line-card style in Edit Items.
 *  - a boxed line (cases) and a plain line (qty) share one quantity input style and one control height
 *  - Unit price and "$ off / unit" use that same control height
 *  - at phone width every row of the card starts at one left edge (no 44px indent under the name)
 * jsdom has no layout, so the claims are pinned on the class tokens the CSS keys off; the measured
 * heights and left edges are the host-run capture's job.
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
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const base = (over: Partial<EditItemState>): EditItemState => ({
  id: "li-1",
  originalProductId: "p-1",
  originalProductName: "Corn Chips",
  originalQty: 24,
  productId: "p-1",
  productName: "Corn Chips",
  qty: 24,
  unitPrice: 18,
  basePrice: 18,
  originalUnitPrice: 18,
  cancelled: false,
  unit: "box",
  unitsPerBox: 12,
  boxSplit: true,
  priceType: "STANDARD",
  ...over,
});
const boxed = base({});
const plain = base({
  id: "li-2",
  originalProductId: "p-2",
  productId: "p-2",
  originalProductName: "Iced Tea",
  productName: "Iced Tea",
  qty: 3,
  originalQty: 3,
  unit: "each",
  unitsPerBox: null,
  boxSplit: false,
  unitPrice: 6.99,
  basePrice: 6.99,
  originalUnitPrice: 6.99,
});

function Harness() {
  const [items, setItems] = React.useState([boxed, plain]);
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 18}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const boxesInput = () => screen.getByTitle(/number of whole/i) as HTMLInputElement;
const qtyInput = () => screen.getByRole("spinbutton", { name: /qty/i }) as HTMLInputElement;

describe("Q28: one line-card variant", () => {
  it("a boxed line and a plain line use the same quantity input style", () => {
    renderWithProviders(<Harness />);
    expect(tokens(boxesInput()).sort()).toEqual(tokens(qtyInput()).sort());
  });

  it("the plain quantity is no longer a tinted box: same white field as the cases field", () => {
    renderWithProviders(<Harness />);
    expect(qtyInput()).toHaveClass("bg-white");
    expect(qtyInput()).not.toHaveClass("bg-surface-raised");
  });

  it("the plain line's quantity is still named 'Qty' for the keyboard and the screen reader", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole("spinbutton", { name: /qty/i })).toHaveValue(3);
    fireEvent.change(qtyInput(), { target: { value: "5" } });
    expect(qtyInput()).toHaveValue(5);
  });
});

describe("Q30: one control height for qty, Unit price and $ off", () => {
  const H = "h-9";
  it("the qty fields and both price fields carry the same height token", () => {
    renderWithProviders(<Harness />);
    expect(boxesInput()).toHaveClass(H);
    expect(qtyInput()).toHaveClass(H);
    for (const label of screen.getAllByLabelText(/^unit price/i)) {
      expect(label.closest("span.rounded") as HTMLElement).toHaveClass(H);
    }
    for (const label of screen.getAllByLabelText(/\$ off/i)) {
      expect(label.closest("span.rounded") as HTMLElement).toHaveClass(H);
    }
  });
});

describe("Q29: one left edge at phone width", () => {
  it("the price row and the note start at the card's own edge below sm (the 44px indent is sm and up)", () => {
    renderWithProviders(<Harness />);
    const priceRows = screen
      .getAllByText(/^unit price$/i)
      .map((s) => s.closest("div") as HTMLElement);
    expect(priceRows).toHaveLength(2);
    for (const row of priceRows) {
      expect(tokens(row)).not.toContain("ml-11");
      expect(tokens(row)).toContain("sm:ml-11");
    }
    for (const note of screen.getAllByPlaceholderText(/note for this line/i)) {
      const wrap = note.parentElement as HTMLElement;
      expect(tokens(wrap)).not.toContain("ml-11");
      expect(tokens(wrap)).toContain("sm:ml-11");
    }
  });

  it("the Substitute / Not available / Remove row lines its text up with that edge (cancels the button padding)", () => {
    renderWithProviders(<Harness />);
    for (const sub of screen.getAllByRole("button", { name: "Substitute" })) {
      expect(tokens(sub.parentElement as HTMLElement)).toContain("max-sm:-ml-2");
    }
  });
});
