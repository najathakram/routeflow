import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * B1373: the counter sale lists its lines through this row. Its optional props each change one thing, and each one's
 * default is the order builder's behaviour (asserted first in every block), so Create Order and vendor bills are unchanged.
 */

const plain: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Chips",
  unit: "each",
  listPrice: 2.5,
  unitPrice: 2.5,
  priceType: "STANDARD",
  qty: 3,
  note: "no salt",
};

const props = (over: Partial<LineItemRowProps> = {}): LineItemRowProps => ({
  item: plain,
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
  onSetQty: jest.fn(),
  ...over,
});

const renderRow = (p: LineItemRowProps) =>
  renderWithProviders(
    <ul>
      <LineItemRow {...p} />
    </ul>,
  );

const note = () => screen.getByPlaceholderText("Flavor or note for this item (prints on invoice)");

describe("LineItemRow counter seams (B1373)", () => {
  it("locked disables every control on the line; unlocked (default) leaves them on", () => {
    const { unmount } = renderRow(props());
    expect(screen.getByTitle("Remove")).toBeEnabled();
    expect(screen.getByTitle("Add flavor / note")).toBeEnabled();
    expect(screen.getByRole("button", { name: "+" })).toBeEnabled();
    unmount();
    renderRow(props({ locked: true }));
    expect(screen.getByTitle("Remove")).toBeDisabled();
    expect(screen.getByTitle("Add flavor / note")).toBeDisabled();
    expect(screen.getByRole("button", { name: "+" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "−" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Quantity" })).toBeDisabled();
    expect(note()).toBeDisabled();
  });

  it("inlinePrice={false} drops the inline Price: box (shown by default)", () => {
    const { unmount } = renderRow(props());
    expect(screen.getByText("Price:")).toBeInTheDocument();
    unmount();
    renderRow(props({ inlinePrice: false }));
    expect(screen.queryByText("Price:")).toBeNull();
  });

  it("hideOriginalPrice drops the struck list price of a discounted line (struck by default)", () => {
    const discounted = { ...plain, priceType: "DISCOUNTED" as const, unitPrice: 2, listPrice: 2.5 };
    const { unmount } = renderRow(props({ item: discounted }));
    expect(screen.getByText("$2.50")).toHaveClass("line-through");
    unmount();
    renderRow(props({ item: discounted, hideOriginalPrice: true }));
    expect(screen.queryByText("$2.50")).toBeNull();
    expect(screen.getByText("Discounted")).toBeInTheDocument();
  });

  it("noteMaxLength caps the note (2000 by default)", () => {
    const { unmount } = renderRow(props());
    expect(note()).toHaveAttribute("maxLength", "2000");
    unmount();
    renderRow(props({ noteMaxLength: 200 }));
    expect(note()).toHaveAttribute("maxLength", "200");
  });

  it("onNoteKeyDown receives the note's keys", () => {
    const onNoteKeyDown = jest.fn();
    renderRow(props({ onNoteKeyDown }));
    fireEvent.keyDown(note(), { key: "Enter" });
    expect(onNoteKeyDown).toHaveBeenCalledTimes(1);
  });

  it("labels name the controls by their line; without labels the names are unchanged", () => {
    const { unmount } = renderRow(props());
    expect(screen.getByRole("button", { name: "+" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Quantity" })).toBeInTheDocument();
    unmount();
    renderRow(
      props({
        labels: {
          remove: "Remove Sample Chips",
          note: "Edit the note on Sample Chips",
          decrease: "Remove one Sample Chips",
          increase: "Add one Sample Chips",
          qty: "Set quantity of Sample Chips",
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Remove Sample Chips" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit the note on Sample Chips" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add one Sample Chips" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove one Sample Chips" })).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Set quantity of Sample Chips" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note for Sample Chips" })).toBeInTheDocument();
  });

  it("the tap-to-change price opens by keyboard too (Enter / Space) and carries its label", () => {
    const onTapPrice = jest.fn();
    renderRow(props({ onTapPrice, labels: { price: "Change price for Sample Chips" } }));
    const price = screen.getByRole("button", { name: "Change price for Sample Chips" });
    fireEvent.keyDown(price, { key: "Enter" });
    fireEvent.keyDown(price, { key: " " });
    fireEvent.keyDown(price, { key: "a" });
    expect(onTapPrice).toHaveBeenCalledTimes(2);
  });

  it("a locked line's price does not open", () => {
    const onTapPrice = jest.fn();
    renderRow(
      props({ onTapPrice, locked: true, labels: { price: "Change price for Sample Chips" } }),
    );
    const price = screen.getByRole("button", { name: "Change price for Sample Chips" });
    fireEvent.click(price);
    fireEvent.keyDown(price, { key: "Enter" });
    expect(onTapPrice).not.toHaveBeenCalled();
  });

  it("touchTargets makes the note and remove icons 44 px below lg (absent by default)", () => {
    const { unmount } = renderRow(props());
    expect(screen.getByTitle("Remove").className).not.toMatch(/max-lg:min-h-11/);
    unmount();
    renderRow(props({ touchTargets: true }));
    expect(screen.getByTitle("Remove").className).toMatch(/max-lg:min-h-11/);
    expect(screen.getByTitle("Add flavor / note").className).toMatch(/max-lg:min-h-11/);
  });

  it("flexFrom=lg keeps the two-column grid up to lg (default: the flex line from sm)", () => {
    const { unmount } = renderRow(props());
    const row = () => screen.getByTitle("Remove").closest("li")!;
    expect(row().className).toMatch(/\bsm:flex\b/);
    unmount();
    renderRow(props({ flexFrom: "lg" }));
    expect(row().className).not.toMatch(/\bsm:flex\b/);
    expect(row().className).toMatch(/\blg:flex\b/);
  });
});
