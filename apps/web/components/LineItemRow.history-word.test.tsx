import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * SA-1066 F07: the clock icon is the real answer to "what did they pay before", but it had no word.
 * A line shows "History" beside the icon at every width, and the word is part of the same button
 * (one click, 44 pt target kept), so the accessible name still contains the visible text.
 */
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const item: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Cola",
  unit: "case",
  listPrice: 12.99,
  unitPrice: 12.99,
  priceType: "STANDARD",
  qty: 1,
};

const props = (): LineItemRowProps => ({
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
  customerPriceHistory: { customerId: "c1", customerName: "Acme", onUsePrice: jest.fn() },
});

describe("F07: the line's clock icon carries the word History", () => {
  it("shows a visible History word inside the Price history button", () => {
    renderWithProviders(
      <ul>
        <LineItemRow {...props()} />
      </ul>,
    );
    const button = screen.getByRole("button", { name: "Price history" });
    expect(within(button).getByText("History")).toBeInTheDocument();
  });

  it("keeps the 44 pt target classes on the button", () => {
    renderWithProviders(
      <ul>
        <LineItemRow {...props()} />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "Price history" }).className).toMatch(/min-h-11/);
    expect(screen.getByRole("button", { name: "Price history" }).className).toMatch(/min-w-11/);
  });
});
