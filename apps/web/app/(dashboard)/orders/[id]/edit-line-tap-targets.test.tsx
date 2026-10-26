/**
 * W-961: on the order Edit Items screen every interactive control in a line row is a >= 44 x 44 px tap target below
 * `lg` (390 px phones and 768 px tablets), and the desktop row is unchanged (every raise is a `max-lg:` class). jsdom has
 * no layout, so the check reads the classes: a control passes when it, or the box that frames it, carries `max-lg:h-11`,
 * `max-lg:min-h-*` (11 = 44 px) or the shared `min-h-[44px]` tap target. The Playwright pass at 1440 / 768 / 390
 * measures the real sizes.
 */
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
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
// A stand-in that forwards `className` to a select, so the row's class on the real picker is observable.
jest.mock("@/components/OrderLineUnitPicker", () => ({
  OrderLineUnitPicker: ({ className }: { className?: string }) => (
    <select aria-label="Sell by" className={className} />
  ),
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

const OPEN = line({ id: "li-open", productName: "Open Widget" });
const CANCELLED = line({
  id: "li-x",
  productId: "p-2",
  productName: "Cancelled Widget",
  cancelled: true,
});
const CUSTOM = line({
  id: "li-c",
  productId: "p-3",
  productName: "Custom Item",
  isUnlisted: true,
  overrideReason: "",
});

const TARGET = /(^|\s)min-h-11(\s|$)|max-lg:h-11|max-lg:min-h-(11|\[44px\])|min-h-\[44px\]/;
const tapOk = (el: Element) =>
  TARGET.test(el.getAttribute("class") ?? "") ||
  TARGET.test(el.parentElement?.getAttribute("class") ?? "");

function card(name: string): HTMLElement {
  const el =
    screen.queryByDisplayValue(name)?.closest("div.rounded-lg") ??
    screen.getByText(name).closest("div.rounded-lg");
  if (!el) throw new Error(`no card for ${name}`);
  return el as HTMLElement;
}

function renderRows() {
  return renderWithProviders(
    <EditableLineItems
      items={[OPEN, CANCELLED, CUSTOM]}
      onChange={() => {}}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 10}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />,
  );
}

describe("order edit builder: line controls are 44px tap targets below lg (W-961)", () => {
  it.each(["Open Widget", "Cancelled Widget", "Custom Item"])("%s: every control", (name) => {
    renderRows();
    const controls = Array.from(
      card(name).querySelectorAll("button, input, select, textarea"),
    ).filter((el) => (el as HTMLInputElement).type !== "hidden");
    expect(controls.length).toBeGreaterThan(0);
    const small = controls.map((el) => ({ el, ok: tapOk(el) })).filter((c) => !c.ok);
    expect(
      small.map(
        (c) =>
          `${c.el.tagName.toLowerCase()} ${(c.el.textContent || c.el.getAttribute("aria-label") || c.el.getAttribute("placeholder") || "").trim().slice(0, 30)}`,
      ),
    ).toEqual([]);
  });
});
