import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";
import { lineStockView } from "@/lib/line-stock";
import { stockViewForLine } from "@/lib/api/stock-availability";

const boxed: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Cola 12pk",
  unit: "case",
  listPrice: 32.99,
  unitPrice: 32.99,
  priceType: "STANDARD",
  qty: 36,
  unitsPerBox: 12,
  boxes: 3,
  pieces: 0,
  sellBy: "case",
};

/** The REAL New Order configuration: both callers (CreateOrderModal, ScanOrderScreen) pass onTapPrice, and the modal passes onSetQty + a unitSlot. */
function realProps(item: LineItemRowItem, stock: LineItemRowProps["stock"]): LineItemRowProps {
  const fn = () => jest.fn();
  return {
    item,
    stock,
    marginFloor: 0,
    floorAcked: false,
    costRevealed: false,
    onTapPrice: jest.fn(),
    onSetQty: jest.fn(),
    unitSlot: <div data-testid="unit-slot" />,
    onQtyDelta: fn(),
    onSetBoxes: fn(),
    onSetPieces: fn(),
    onSetUnitQty: fn(),
    onSetSellBy: fn(),
    onSetDiscountedPrice: fn(),
    onSetToFloor: fn(),
    onAckFloor: fn(),
    onToggleCostRevealed: fn(),
    onToggleNoteOpen: fn(),
    onSetNote: fn(),
    onUpdateUnlistedName: fn(),
    onUpdateUnlistedPrice: fn(),
    onRemove: fn(),
  };
}
const renderRow = (p: LineItemRowProps) =>
  renderWithProviders(
    <ul>
      <LineItemRow {...p} />
    </ul>,
  );

describe("LineItemRow live stock (real config: onTapPrice set)", () => {
  it("renders the stock line even though onTapPrice hides the inline price input", () => {
    const stock = lineStockView({ line: boxed, availablePieces: 60, allowOversell: false });
    renderRow(realProps(boxed, stock));
    const li = screen.getByRole("listitem");
    expect(within(li).queryByText("Case price:")).toBeNull(); // proves we are in the onTapPrice config
    const note = within(li).getByTestId("line-stock");
    expect(note).toHaveTextContent("5 cases left");
    expect(note).toHaveAttribute("data-level", "ok");
    expect(within(li).queryByTestId("line-stock-message")).toBeNull();
  });

  it("amber when the order exceeds stock; blocking copy is an alert", () => {
    const stock = lineStockView({ line: boxed, availablePieces: 24, allowOversell: false });
    renderRow(realProps(boxed, stock));
    const note = screen.getByTestId("line-stock");
    expect(note).toHaveAttribute("data-level", "low");
    expect(note.className).toContain("text-amber-700");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only 2 cases left \u2014 reduce or remove",
    );
  });

  it("allow-oversell policy shows a soft status note, not an alert", () => {
    const stock = lineStockView({ line: boxed, availablePieces: 24, allowOversell: true });
    renderRow(realProps(boxed, stock));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("line-stock-message")).toHaveTextContent(
      "Only 2 cases left \u2014 this order will go below stock",
    );
  });

  it("red at 0", () => {
    const stock = lineStockView({ line: boxed, availablePieces: 0, allowOversell: true });
    renderRow(realProps(boxed, stock));
    const note = screen.getByTestId("line-stock");
    expect(note).toHaveAttribute("data-level", "out");
    expect(note.className).toContain("text-danger");
    expect(note).toHaveTextContent("0 left");
  });

  it("loading never shows 0", () => {
    const stock = stockViewForLine({ data: undefined, isError: false, isFetching: true }, boxed);
    renderRow(realProps(boxed, stock));
    const note = screen.getByTestId("line-stock");
    expect(note).toHaveAttribute("data-state", "loading");
    expect(note).toHaveTextContent("Checking stock");
    expect(note.textContent).not.toMatch(/\b0\b/);
  });

  it("a failed lookup shows nothing (the server stays the authority)", () => {
    const stock = stockViewForLine({ data: undefined, isError: true, isFetching: false }, boxed);
    expect(stock).toBeUndefined();
    renderRow(realProps(boxed, stock));
    expect(screen.queryByTestId("line-stock")).toBeNull();
  });
});

describe("stockViewForLine", () => {
  const data = { allowOversell: false, items: [{ productId: "p1", availablePieces: 30 }] };
  it("uses the server's number for the line's product", () => {
    expect(
      stockViewForLine({ data, isError: false, isFetching: false }, { ...boxed, qty: 36 }),
    ).toMatchObject({ level: "low", blocksSubmit: true, label: "2 cases + 6 units left" });
  });
  it("skips unlisted lines and products the server did not return", () => {
    expect(
      stockViewForLine({ data, isError: false, isFetching: false }, { ...boxed, isUnlisted: true }),
    ).toBeUndefined();
    expect(
      stockViewForLine({ data, isError: false, isFetching: false }, { ...boxed, productId: "zz" }),
    ).toBeUndefined();
  });
});
