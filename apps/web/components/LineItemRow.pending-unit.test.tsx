import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

/**
 * #2865 case c (SA-632): while a line's default selling unit is unresolved the qty controls are DISABLED and
 * aria-busy, the row shows the PENDING TAP COUNT ("3 · loading units"), and a failed load shows a readable error with
 * a real, keyboard-reachable Retry button. Quantity must never depend on load timing.
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
    qty: 1,
    ...over,
  }) as LineItemRowItem;

const noop = jest.fn();
const props = (over: Partial<LineItemRowProps> = {}): LineItemRowProps =>
  ({
    item: item(),
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
    ...over,
  }) as LineItemRowProps;

const renderRow = (p: LineItemRowProps) =>
  render(
    <ul>
      <LineItemRow {...p} />
    </ul>,
  );

beforeEach(() => noop.mockClear());

describe("LineItemRow, pending selling unit", () => {
  it("LOADING: the plain stepper and the typed qty are disabled, aria-busy, with the tap count + 'loading units'", () => {
    renderRow(props({ pendingUnit: { status: "loading", taps: 3, onRetry: noop } }));
    const group = screen.getByRole("group", { name: /locked while the selling unit loads/i });
    expect(group).toBeDisabled();
    expect(group).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "+" })).toBeDisabled();
    expect(screen.getByLabelText("Quantity")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("3 · loading units");
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    expect(noop).not.toHaveBeenCalled(); // nothing added
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("LOADING on a case-packed line: the case and unit controls are locked too", () => {
    renderRow(
      props({
        item: item({ unitsPerBox: 12, boxes: 1, pieces: 0, qty: 12 }),
        pendingUnit: { status: "loading", taps: 2, onRetry: noop },
      }),
    );
    expect(screen.getByTestId("line-qty-controls")).toBeDisabled();
    expect(screen.getByTestId("line-qty-controls")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Case" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ units" })).toBeDisabled();
  });

  it("FAILED: a readable error and a REAL Retry button (reachable by keyboard); the controls stay locked, nothing is added", () => {
    const onRetry = jest.fn();
    renderRow(props({ pendingUnit: { status: "failed", taps: 3, onRetry } }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the selling units");
    expect(alert).toHaveTextContent("3 added");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.tagName).toBe("BUTTON");
    expect(retry).not.toBeDisabled();
    expect(retry.getAttribute("tabindex")).not.toBe("-1");
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "+" })).toBeDisabled();
    expect(noop).not.toHaveBeenCalled();
  });

  it("SETTLED (no pendingUnit): the controls work as before and nothing is busy", () => {
    renderRow(props());
    expect(screen.getByRole("button", { name: "+" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    expect(noop).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId("pending-unit-status")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Line quantity controls" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
});
