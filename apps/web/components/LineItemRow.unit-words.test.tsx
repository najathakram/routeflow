import * as React from "react";
import { render, screen } from "@testing-library/react";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * U-3a: the row's unit words come from unitWords(). Defaults print the VU-1 words exactly; a
 * tenant word flows through every label; a long word truncates instead of wrapping the row; and a
 * ladder line (its own unit, no pack) never claims a "Box price".
 */
const item = (over: Partial<LineItemRowItem> = {}): LineItemRowItem =>
  ({
    tempId: "a",
    productId: "p1",
    productName: "Soda",
    unit: "Case",
    listPrice: 24,
    unitPrice: 24,
    priceType: "STANDARD",
    qty: 24,
    unitsPerBox: 12,
    boxes: 2,
    pieces: 0,
    ...over,
  }) as LineItemRowItem;

const noop = jest.fn();
const props = (over: Partial<LineItemRowItem> = {}): LineItemRowProps =>
  ({
    item: item(over),
    marginFloor: 0,
    floorAcked: false,
    costRevealed: false,
    onQtyDelta: noop,
    onSetBoxes: noop,
    onSetPieces: noop,
    onSetUnitQty: noop,
    onSetSellBy: noop,
    onSetDiscountedPrice: noop,
    onSetToFloor: noop,
    onAckFloor: noop,
    onToggleCostRevealed: noop,
    onToggleNoteOpen: noop,
    onSetNote: noop,
    onUpdateUnlistedName: noop,
    onUpdateUnlistedPrice: noop,
    onRemove: noop,
    onSetQty: noop,
  }) as LineItemRowProps;

const renderRow = (over: Partial<LineItemRowItem> = {}) =>
  render(
    <ul>
      <LineItemRow {...props(over)} />
    </ul>,
  );

describe("LineItemRow unit words: defaults", () => {
  it("prints the VU-1 Box / Piece words", () => {
    renderRow({ boxes: 1, pieces: 1, qty: 13 });
    expect(screen.getByRole("button", { name: "Box" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Piece" })).toBeInTheDocument();
    expect(screen.getByText("Box price:")).toBeInTheDocument();
    expect(screen.getByTitle("Number of whole boxes")).toBeInTheDocument();
    expect(screen.getByLabelText("Extra pieces")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove extra pieces")).toBeInTheDocument();
    expect(screen.getByTestId("line-qty-cases-row")).toHaveTextContent("box");
    expect(screen.getByText(/1 box = 12 pcs/)).toBeInTheDocument();
    expect(screen.getByText("13 pcs total")).toBeInTheDocument();
  });

  it("says 'pc' for exactly one piece", () => {
    renderRow({ boxes: 0, pieces: 1, qty: 1 });
    expect(screen.getByText("1 pc total")).toBeInTheDocument();
  });
});

describe("LineItemRow unit words: T-V1 ladder line", () => {
  it("a line sold by its own unit (no pack) never shows 'Box price'", () => {
    renderRow({ unitLabel: "Case", unitsPerBox: undefined, boxes: undefined, pieces: undefined });
    expect(screen.queryByText(/Box price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/box/i)).not.toBeInTheDocument();
  });
});

describe("LineItemRow unit words: tenant words", () => {
  it("flows a custom pack and base word through every label", () => {
    renderRow({ packLabel: "Crate", baseUnitLabel: "Bottle", boxes: 2, pieces: 3, qty: 27 });
    expect(screen.getByText("Crate price:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bottle" })).toBeInTheDocument();
    expect(screen.getByTitle("Number of whole crates")).toBeInTheDocument();
    expect(screen.getByLabelText("Extra bottles")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove extra bottles")).toBeInTheDocument();
    expect(screen.getByText(/1 crate = 12 bottle/)).toBeInTheDocument();
    expect(screen.queryByText(/\bpcs?\b/)).not.toBeInTheDocument();
  });
});

describe("LineItemRow unit words: long tenant words", () => {
  it("cuts a long label in the sell-by pill to 11 characters plus a dot, full word in aria-label", () => {
    renderRow({ packLabel: "Shrinkwrapped tray" });
    const pill = screen.getByRole("button", { name: "Shrinkwrapped tray" });
    expect(pill).toHaveTextContent("Shrinkwrapp.");
    expect(pill).toHaveAttribute("title", "Shrinkwrapped tray");
    expect(pill.className).toContain("max-w-[104px]");
    expect(pill.className).toContain("truncate");
  });

  it("leaves a short label whole with no extra aria-label or title", () => {
    renderRow({ packLabel: "Crate" });
    const pill = screen.getByRole("button", { name: "Crate" });
    expect(pill).toHaveTextContent("Crate");
    expect(pill).not.toHaveAttribute("title");
  });

  it("truncates the count word with an ellipsis and keeps the full word as its tooltip", () => {
    renderRow({ packLabel: "Shrinkwrapped tray", boxes: 2 });
    const word = screen.getByTitle("Shrinkwrapped trays");
    expect(word).toHaveTextContent("shrinkwrapped trays");
    expect(word.className).toContain("truncate");
    expect(word.className).toContain("max-w-[6rem]");
  });
});
