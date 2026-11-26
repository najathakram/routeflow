/**
 * REG-B1423 (R-214 MEDIUM 1 and 2): two more ways a price the system set kept a reference it should not have.
 * 1. Picking the derived Piece keeps the previous unit's list (a Case at 120.00), so a typed 12.00 read
 *    "90% below list ($120.00)" against the pack price.
 * 2. A substitution kept `priceEdited` from a price typed before it, so the substitute's own 4.50 read
 *    "55% below list ($10.00)" before anyone typed it.
 * 3. (R-231 MEDIUM A) Undo of a substitution kept `priceEdited` from a price typed on the substitute, so the
 *    restored contract 4.50 read "55% below list ($10.00)".
 */
import * as React from "react";
import type { ProductUnitLevel } from "@routeflow/types";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { farFromListText } from "@/lib/far-from-list";
import { derivedUnitPatch } from "@/lib/edit-line-derived-unit";
import { buildUnitOptions } from "@/lib/unit-options";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";
import { lineFarFromListReference } from "./_components/line-far-from-list";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
const SODA = {
  id: "p-soda",
  name: "Sample Soda",
  kind: "STANDARD",
  unit: "each",
  pricePerUnit: "10.00",
  isActive: true,
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [SODA] } }),
}));

const noteFor = (it: Parameters<typeof lineFarFromListReference>[0]) =>
  farFromListText(it.unitPrice, lineFarFromListReference(it) ?? 0);

function line(over: Partial<EditItemState>): EditItemState {
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
    listReference: 10,
    originalListReference: 10,
    cancelled: false,
    unit: "each",
    unitsPerBox: null,
    boxSplit: false,
    priceType: "STANDARD",
    ...over,
  } as EditItemState;
}

describe("REG-B1423 R-214 MEDIUM 1: a derived Piece pick drops the previous unit's list", () => {
  // A $10.00 3-pack with a Case level (list 120.00 on the line) and no Piece row: the Piece is derived.
  const CASE = {
    id: "Case",
    label: "Case",
    factorToBase: 72,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  } as ProductUnitLevel;
  const options = buildUnitOptions({ unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" }, [CASE]);
  const piece = options.find((o) => o.factorToBase === 1)!;

  it("Case line at list 120.00, pick Piece, type 12.00: no note against 120.00", () => {
    const caseLine = line({
      unitLabel: "Case",
      unitPrice: 120,
      originalUnitPrice: 120,
      listReference: 120,
      originalListReference: 120,
      unitsPerBox: 3,
    });
    const patch = derivedUnitPatch(caseLine, piece, false);
    expect(patch).not.toBeNull();
    const typed = { ...caseLine, ...patch, unitPrice: 12, priceEdited: true } as EditItemState;
    // master: "90% below list ($120.00)"
    expect(noteFor(typed)).toBeNull();
  });
});

describe("REG-B1423 R-214 MEDIUM 2: a substitution is a system-set price again", () => {
  it("type 3.00, then Substitute: the substitute's 4.50 says nothing until typed", () => {
    const onChange = jest.fn();
    Element.prototype.scrollIntoView = jest.fn();
    renderWithProviders(
      <EditableLineItems
        items={[line({ unitPrice: 3, priceEdited: true })]}
        onChange={onChange}
        onAdd={() => {}}
        onDelete={() => {}}
        canEditPrice
        tierPriceFor={() => 4.5}
        isSpecialTierFor={() => false}
        tierForProductId={() => 1}
        pricingReady
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Substitute" }));
    fireEvent.change(screen.getByPlaceholderText("Search products…"), {
      target: { value: "soda" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Sample Soda/ }));
    const next = onChange.mock.calls.at(-1)![0][0] as EditItemState;
    expect(next.unitPrice).toBe(4.5);
    expect(next.listReference).toBe(10);
    expect(next.priceEdited).toBe(false);
    // master: "55% below list ($10.00)"
    expect(noteFor(next)).toBeNull();
  });
});

describe("REG-B1423 R-231 MEDIUM A: Undo of a substitution is a system-set price again", () => {
  /** The editor with its own state, as the order page holds it: every change re-renders the lines. */
  function Stateful({ start }: { start: EditItemState }) {
    const [items, setItems] = React.useState([start]);
    return (
      <EditableLineItems
        items={items}
        onChange={setItems}
        onAdd={() => {}}
        onDelete={() => {}}
        canEditPrice
        tierPriceFor={() => 4.5}
        isSpecialTierFor={() => false}
        tierForProductId={() => 1}
        pricingReady
      />
    );
  }

  it("a saved contract line (4.50, list 10.00): Substitute, type 2.00, Undo -> 4.50 back with no note", () => {
    Element.prototype.scrollIntoView = jest.fn();
    renderWithProviders(
      <Stateful
        start={line({
          priceType: "SPECIAL",
          unitPrice: 4.5,
          originalUnitPrice: 4.5,
          basePrice: 10,
          originalBasePrice: 10,
          listReference: 10,
          originalListReference: 10,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Substitute" }));
    fireEvent.change(screen.getByPlaceholderText("Search products…"), {
      target: { value: "soda" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Sample Soda/ }));
    const price = screen.getByRole("textbox", { name: /^Price/ });
    fireEvent.change(price, { target: { value: "2.00" } });
    fireEvent.blur(price);
    // the typed price on the substitute does speak (it was typed)
    expect(screen.getByTestId("price-far-from-list")).toHaveTextContent("80% below list ($10.00)");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("textbox", { name: /^Price/ })).toHaveValue("4.50");
    // master of this branch: "55% below list ($10.00)" on the restored contract price nobody typed
    expect(screen.queryByTestId("price-far-from-list")).toBeNull();
  });
});
