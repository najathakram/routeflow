import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * Characterization + layout-contract tests for the shared editable row.
 *
 * B565: at 390px the boxed row's controls (`min-w-[190px]` qty block + total + two icon
 * buttons) squeezed the info column to ~40px, so the price text overlapped the Case/Unit
 * toggle and "Set to floor / Sell anyway" wrapped word by word. JSDOM computes no layout, so
 * the fix is pinned two ways: the class contract below (a revert to the bare flex row fails
 * here) and the Lane F Playwright bbox/overlap probe at 390 (the pixels themselves).
 */

const boxedItem: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Cola 12pk",
  unit: "case",
  listPrice: 32.99,
  unitPrice: 32.99,
  priceType: "STANDARD",
  qty: 12,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 0,
  sellBy: "case",
};

const plainItem: LineItemRowItem = {
  tempId: "t2",
  productId: "p2",
  productName: "Sample Chips",
  unit: "each",
  listPrice: 2.5,
  unitPrice: 2.5,
  priceType: "STANDARD",
  qty: 3,
};

function makeProps(item: LineItemRowItem): LineItemRowProps {
  return {
    item,
    marginFloor: 0,
    floorAcked: false,
    costRevealed: false,
    onQtyDelta: jest.fn(),
    onSetBoxes: jest.fn(),
    onSetPieces: jest.fn(),
    onSetUnitQty: jest.fn(),
    onSetSellBy: jest.fn(),
    onSetDiscountedPrice: jest.fn(),
    onSetToFloor: jest.fn(),
    onAckFloor: jest.fn(),
    onToggleCostRevealed: jest.fn(),
    onToggleNoteOpen: jest.fn(),
    onSetNote: jest.fn(),
    onUpdateUnlistedName: jest.fn(),
    onUpdateUnlistedPrice: jest.fn(),
    onRemove: jest.fn(),
  };
}

function renderRow(props: LineItemRowProps) {
  return renderWithProviders(
    <ul>
      <LineItemRow {...props} />
    </ul>,
  );
}

describe("LineItemRow layout contract (B565)", () => {
  it("is a 2-column grid under sm and the original flex row from sm up", () => {
    renderRow(makeProps(boxedItem));
    const li = screen.getByRole("listitem");
    expect(li).toHaveClass("grid", "grid-cols-[minmax(0,1fr)_auto]", "sm:flex", "sm:items-start");
  });

  it("places info top-left, actions top-right, qty controls bottom-left, total bottom-right", () => {
    renderRow(makeProps(boxedItem));
    const li = screen.getByRole("listitem");
    const info = within(li).getByText("Sample Cola 12pk").parentElement!;
    expect(info).toHaveClass("col-start-1", "row-start-1");

    const qty = within(li).getByText(/1 case = 12 units/).parentElement!;
    expect(qty).toHaveClass("col-start-1", "row-start-2");

    const total = within(li).getByText("$32.99", { selector: "span.font-semibold" });
    expect(total).toHaveClass("col-start-2", "row-start-2");

    const remove = within(li).getByTitle("Remove");
    expect(remove.parentElement).toHaveClass("col-start-2", "row-start-1");
    // The note/remove pair must not touch under sm (remove has no confirm step).
    expect(remove.parentElement).toHaveClass("gap-2", "sm:gap-3");
  });

  it("keeps the same placement for a non-boxed line's stepper", () => {
    renderRow(makeProps(plainItem));
    const li = screen.getByRole("listitem");
    const stepper = within(li).getByText("3").parentElement!;
    expect(stepper).toHaveClass("col-start-1", "row-start-2");
  });
});

describe("LineItemRow behaviour is unchanged by the layout wrapper", () => {
  it("boxed: the sell-by toggle, note toggle, remove and case input reach their callbacks", async () => {
    const user = userEvent.setup();
    const props = makeProps(boxedItem);
    renderRow(props);

    await user.click(screen.getByRole("button", { name: "Unit" }));
    expect(props.onSetSellBy).toHaveBeenCalledWith("unit");

    await user.click(screen.getByTitle("Add flavor / note"));
    expect(props.onToggleNoteOpen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTitle("Remove"));
    expect(props.onRemove).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByTitle("Number of whole cases"));
    expect(props.onSetBoxes).toHaveBeenCalled();
  });

  it("non-boxed: the stepper calls onQtyDelta", async () => {
    const user = userEvent.setup();
    const props = makeProps(plainItem);
    renderRow(props);
    await user.click(screen.getByRole("button", { name: "+" }));
    expect(props.onQtyDelta).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "−" }));
    expect(props.onQtyDelta).toHaveBeenCalledWith(-1);
  });

  it("the line total comes from computeLineSubtotal (boxed line prorates per case)", () => {
    renderRow(makeProps({ ...boxedItem, boxes: 2, pieces: 6, qty: 30 }));
    // 2 cases + 6/12 of a case at 32.99/case = 82.475 -> boxed proration, not qty * unitPrice.
    expect(screen.getByText("$82.48", { selector: "span.font-semibold" })).toBeInTheDocument();
  });
});
