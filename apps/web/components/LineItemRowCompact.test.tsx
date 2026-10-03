import * as React from "react";
import userEvent from "@testing-library/user-event";
import { computeLineSubtotal } from "@routeflow/pricing";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import type { LineItemRowItem, LineItemRowProps } from "./LineItemRow";
import { LineItemRowCompact } from "./LineItemRowCompact";

/**
 * Redesign PR1 (SA-641 §6): the compact row changes LAYOUT only. A collapsed row shows
 * name · meta · stepper · amount; the Fold holds unit / price / margin / note. Every #2865
 * pending-unit rule, the typed qty, the tags and the amount stay exactly as in LineItemRow.
 */
const plain: LineItemRowItem = {
  tempId: "t2",
  productId: "p2",
  productName: "Sample Chips",
  unit: "each",
  listPrice: 2.5,
  unitPrice: 2.5,
  priceType: "STANDARD",
  qty: 3,
};
const boxed: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Cola 12pk",
  unit: "case",
  listPrice: 24,
  unitPrice: 24,
  priceType: "STANDARD",
  qty: 27,
  unitsPerBox: 12,
  boxes: 2,
  pieces: 3,
  sellBy: "case",
};

const props = (item: LineItemRowItem, over: Partial<LineItemRowProps> = {}): LineItemRowProps => ({
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
  ...over,
});
const renderRow = (p: LineItemRowProps) =>
  renderWithProviders(
    <ul>
      <LineItemRowCompact {...p} />
    </ul>,
  );
const foldRegion = (c: HTMLElement) => c.querySelector("[data-state]") as HTMLElement;

describe("LineItemRowCompact: collapsed layout", () => {
  it("shows name, price meta, stepper and amount; the fold is closed and inert", () => {
    const { container } = renderRow(props(plain));
    expect(screen.getByText("Sample Chips")).toBeInTheDocument();
    expect(screen.getByText(/\$2\.50 \/ each/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Line quantity controls" })).toBeInTheDocument();
    expect(screen.getByTestId("line-total")).toHaveTextContent("$7.50");
    expect(screen.getByRole("button", { name: /more/i })).toHaveAttribute("aria-expanded", "false");
    expect(foldRegion(container)).toHaveAttribute("inert");
  });

  it("the fold holds the unit slot and the price field", async () => {
    const { container } = renderRow(
      props(plain, { unitSlot: <div data-testid="unit-slot">units</div> }),
    );
    const region = foldRegion(container);
    expect(within(region).getByTestId("unit-slot")).toBeInTheDocument();
    expect(within(region).getByText("Price:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(region).not.toHaveAttribute("inert");
  });

  it("the amount is the computeLineSubtotal value: a boxed line with loose pieces prorates", () => {
    renderRow(props(boxed));
    const expected = computeLineSubtotal({
      unitPrice: 24,
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 12,
    });
    expect(screen.getByTestId("line-total")).toHaveTextContent(`$${expected.toFixed(2)}`);
    expect(screen.getByTestId("line-total")).toHaveTextContent("$54.00");
    expect(screen.getByTestId("line-total")).not.toHaveTextContent("$648.00");
  });

  it("a note shows under the row and round-trips; the toggle opens an empty one", async () => {
    const onSetNote = jest.fn();
    renderRow(props({ ...plain, note: "no ice" }, { onSetNote }));
    expect(screen.getByLabelText("Line note")).toHaveValue("no ice");
    await userEvent.type(screen.getByLabelText("Line note"), "x");
    expect(onSetNote).toHaveBeenCalledWith("no icex");
  });

  it("the note toggle (title 'Add flavor / note') calls onToggleNoteOpen; an open empty note shows its field", async () => {
    const p = props(plain);
    const { unmount } = renderRow(p);
    expect(screen.queryByLabelText("Line note")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTitle("Add flavor / note"));
    expect(p.onToggleNoteOpen).toHaveBeenCalledTimes(1);
    unmount();
    renderRow(props({ ...plain, noteOpen: true }));
    expect(screen.getByLabelText("Line note")).toHaveValue("");
  });
});

describe("LineItemRowCompact: tags and hints", () => {
  it("Special / Discounted / Upsell / regulated tags and the Last: price render", () => {
    const a = renderRow(props({ ...plain, priceType: "SPECIAL", listPrice: 3, unitPrice: 2.5 }));
    expect(screen.getByText("Special price")).toBeInTheDocument();
    a.unmount();
    const b = renderRow(props({ ...plain, priceType: "DISCOUNTED", listPrice: 3, unitPrice: 2 }));
    expect(screen.getByText("Discounted")).toBeInTheDocument();
    b.unmount();
    const c = renderRow(props({ ...plain, priceType: "MANUAL", listPrice: 2, unitPrice: 3 }));
    expect(screen.getByText("Upsell")).toBeInTheDocument();
    c.unmount();
    renderRow(
      props(plain, {
        category: { name: "Tobacco" } as LineItemRowProps["category"],
        priceHistoryEntry: { lastPrice: 2.25 },
      }),
    );
    expect(screen.getByText("Tobacco · regulated")).toBeInTheDocument();
    expect(screen.getByText("Last: $2.25")).toBeInTheDocument();
  });

  it("cost is concealed by default (the cost eye is off)", () => {
    renderRow(props({ ...plain, unitCost: 1.25 }));
    expect(screen.queryByText(/\$1\.25/)).not.toBeInTheDocument();
  });

  it("tap-to-edit price: onTapPrice is wired and there is no inline price box", async () => {
    const onTapPrice = jest.fn();
    renderRow(props(plain, { onTapPrice }));
    expect(screen.queryByText("Price:")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /\$2\.50/ }));
    expect(onTapPrice).toHaveBeenCalledTimes(1);
  });
});

describe("LineItemRowCompact: typed quantity and callbacks", () => {
  it("a plain line: the stepper and a typed qty reach their callbacks", () => {
    const p = props(plain, { onSetQty: jest.fn() });
    renderRow(p);
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "9" } });
    expect(p.onSetQty).toHaveBeenCalledWith(9);
    fireEvent.click(screen.getByText("+"));
    expect(p.onQtyDelta).toHaveBeenCalledWith(1);
  });

  it("a boxed line: typed Boxes and Pieces reach their callbacks", () => {
    const p = props(boxed);
    renderRow(p);
    fireEvent.change(screen.getByTitle("Number of whole cases"), { target: { value: "4" } });
    expect(p.onSetBoxes).toHaveBeenCalledWith(4);
    fireEvent.change(screen.getByLabelText("Extra loose units"), { target: { value: "5" } });
    expect(p.onSetPieces).toHaveBeenCalledWith(5);
  });

  it("remove calls onRemove", async () => {
    const p = props(plain);
    renderRow(p);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(p.onRemove).toHaveBeenCalledTimes(1);
  });

  it("a custom line edits its name and price inline", () => {
    const p = props({ ...plain, isUnlisted: true, productId: "" });
    renderRow(p);
    fireEvent.change(screen.getByPlaceholderText("Item name"), { target: { value: "Ice" } });
    expect(p.onUpdateUnlistedName).toHaveBeenCalledWith("Ice");
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });
});

describe("LineItemRowCompact: #2865 pending unit stays locked", () => {
  const pending = (over = {}) => ({
    status: "loading" as const,
    taps: 3,
    onRetry: jest.fn(),
    ...over,
  });

  it("loading: every qty control is disabled + aria-busy and the tap count shows", () => {
    renderRow(props(plain, { pendingUnit: pending(), onSetQty: jest.fn() }));
    const fs = screen.getByRole("group", { name: /locked while the selling unit loads/i });
    expect(fs).toBeDisabled();
    expect(fs).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("+")).toBeDisabled();
    expect(screen.getByLabelText("Quantity")).toBeDisabled();
    expect(screen.getByTestId("pending-unit-status")).toHaveTextContent("3 · loading units");
  });

  it("a boxed line is locked too (case/unit toggle, boxes, pieces)", () => {
    renderRow(props(boxed, { pendingUnit: pending() }));
    expect(screen.getByRole("button", { name: "Case" })).toBeDisabled();
    expect(screen.getByTitle("Number of whole cases")).toBeDisabled();
  });

  it("failed: a readable error and a real Retry button", async () => {
    const onRetry = jest.fn();
    renderRow(props(plain, { pendingUnit: pending({ status: "failed", onRetry }) }));
    expect(screen.getByRole("alert")).toHaveTextContent("3 added");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("the tap-to-edit price opens nothing while pending", async () => {
    const onTapPrice = jest.fn();
    renderRow(props(plain, { onTapPrice, pendingUnit: pending() }));
    await userEvent.click(screen.getByRole("button", { name: /\$2\.50/ }));
    expect(onTapPrice).not.toHaveBeenCalled();
  });

  it("the pending status is NOT inside the closed fold", () => {
    const { container } = renderRow(props(plain, { pendingUnit: pending() }));
    expect(foldRegion(container).contains(screen.getByTestId("pending-unit-status"))).toBe(false);
  });
});
