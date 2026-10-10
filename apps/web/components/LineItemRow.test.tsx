import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";

import { unitWords } from "@routeflow/pricing";

// U-3a: the add-extra control is named by the default unit words.
const ADD_EXTRA = `Add extra ${unitWords().base.lowerOther}`;

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

    const qty = within(li).getByText(/1 box = 12 pcs/).parentElement!;
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

  // #2080 v2: at 320px the cases/units row (~186px) ran past its ~170-182px track into the line
  // total. The row wraps, but each "[n] cases" / "+ [n] units" group stays whole, so the units
  // group drops to its own line instead of splitting mid-group. Pixels: e2e 56's content probe.
  it("wraps the cases/units row between two no-wrap groups (#2080)", () => {
    // pieces > 0: the opt-in loose-units group is shown (#2696 d).
    renderRow(makeProps({ ...boxedItem, pieces: 2 }));
    const row = screen.getByTestId("line-qty-cases-row");
    expect(row).toHaveClass("flex", "flex-wrap");
    const cases = screen.getByTitle("Number of whole boxes").parentElement!;
    const units = screen.getByTitle("Extra pieces (less than a full box)").parentElement!;
    expect(cases).not.toBe(units);
    for (const group of [cases, units]) {
      expect(group.parentElement).toBe(row);
      expect(group).toHaveClass("whitespace-nowrap");
    }
    expect(within(cases).getByText(/^box(es)?$/)).toBeInTheDocument();
    expect(within(units).getByText("+")).toBeInTheDocument();
    expect(within(units).getByText(/^pcs?$/)).toBeInTheDocument();
  });

  // SA-558d: one wording in the row and the sheet (PriceEditor.test "case wording").
  it("says '1 case' / 'n cases' and '1 unit' / 'n units'", () => {
    const row = () => within(screen.getByTestId("line-qty-cases-row"));
    const { unmount } = renderRow(makeProps({ ...boxedItem, boxes: 1, pieces: 1 }));
    expect(row().getByText("box")).toBeInTheDocument();
    expect(row().getByText("pc")).toBeInTheDocument();
    unmount();
    renderRow(makeProps({ ...boxedItem, boxes: 3, pieces: 2 }));
    expect(row().getByText("boxes")).toBeInTheDocument();
    expect(row().getByText("pcs")).toBeInTheDocument();
  });
});

describe("LineItemRow behaviour is unchanged by the layout wrapper", () => {
  it("boxed: the sell-by toggle, note toggle, remove and case input reach their callbacks", async () => {
    const user = userEvent.setup();
    const props = makeProps(boxedItem);
    renderRow(props);

    await user.click(screen.getByRole("button", { name: "Piece" }));
    expect(props.onSetSellBy).toHaveBeenCalledWith("unit");

    await user.click(screen.getByTitle("Add flavor / note"));
    expect(props.onToggleNoteOpen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTitle("Remove"));
    expect(props.onRemove).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByTitle("Number of whole boxes"));
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

describe("B715: the tap-to-edit price has a visible affordance only when onTapPrice is set", () => {
  it("renders the pencil icon and the phone-width helper when onTapPrice is provided", () => {
    renderRow({ ...makeProps(plainItem), onTapPrice: jest.fn() });
    expect(screen.getByLabelText("Change price")).toBeInTheDocument();
    expect(screen.getByText("Tap to change")).toBeInTheDocument();
  });

  it("renders neither the pencil icon nor the helper when onTapPrice is omitted", () => {
    renderRow(makeProps(plainItem));
    expect(screen.queryByLabelText("Change price")).not.toBeInTheDocument();
    expect(screen.queryByText("Tap to change")).not.toBeInTheDocument();
  });

  // #2696 (b), owner: "tap on the price and change it" — not a text box beside it. With the tap
  // wired the sheet owns the price, so the row renders no inline price box; without it, it does.
  it("renders no inline price box when onTapPrice is provided, and one when it is omitted", () => {
    const { unmount } = renderRow({ ...makeProps(plainItem), onTapPrice: jest.fn() });
    expect(screen.queryByText("Price:")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    unmount();
    renderRow(makeProps(plainItem));
    expect(screen.getByText("Price:")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });
});

describe("multi-line per-item notes", () => {
  const noteFieldFor = (item: LineItemRowItem) =>
    renderRow(makeProps({ ...item, noteOpen: true })).getByPlaceholderText(
      /note for this item/i,
    ) as HTMLTextAreaElement;

  it("the note field is a <textarea>, not a single-line <input>", () => {
    const field = noteFieldFor(plainItem);
    expect(field.tagName).toBe("TEXTAREA");
  });

  it("caps at 2000 characters, the same cap raised server-side for updateOrderItems", () => {
    const field = noteFieldFor(plainItem);
    expect(field).toHaveAttribute("maxLength", "2000");
  });

  it("Enter inserts a newline instead of doing nothing (the field has no onKeyDown of its own)", async () => {
    const user = userEvent.setup();
    const props = makeProps({ ...plainItem, noteOpen: true, note: "line one" });
    renderRow(props);
    const field = screen.getByPlaceholderText(/note for this item/i) as HTMLTextAreaElement;
    // Cursor explicitly at the end of the existing value — onSetNote is a bare mock with no
    // state to feed back, so this proves the browser's native textarea behavior inserts \n
    // (nothing here does it manually), not a controlled-component re-render artifact.
    await user.type(field, "{Enter}line two", {
      initialSelectionStart: field.value.length,
      initialSelectionEnd: field.value.length,
    });
    const calls = (props.onSetNote as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(calls.some((v) => v.includes("\n"))).toBe(true);
  });

  it("a note already carrying multiple lines round-trips through the value prop intact", () => {
    const field = noteFieldFor({ ...plainItem, note: "line one\nline two\nline three" });
    expect(field.value).toBe("line one\nline two\nline three");
  });
});

// SA-563 (#2696 d): "Remove extra pieces" is hidden at 0 cases — the units are then the whole line.
describe("SA-563: the remove-extra-units control needs at least one case", () => {
  it("cases 0 + units n ⇒ the control is absent", () => {
    renderRow(makeProps({ ...boxedItem, boxes: 0, pieces: 3, qty: 3 }));
    expect(screen.getByLabelText("Extra pieces")).toBeInTheDocument();
    expect(screen.queryByLabelText("Remove extra pieces")).not.toBeInTheDocument();
  });

  it("cases ≥ 1 + units n ⇒ present; tapping it sets units 0, leaves cases alone and keeps the line", () => {
    const props = makeProps({ ...boxedItem, boxes: 2, pieces: 3, qty: 27 });
    renderRow(props);
    fireEvent.click(screen.getByLabelText("Remove extra pieces"));
    expect(props.onSetPieces).toHaveBeenCalledWith(0);
    expect(props.onSetBoxes).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
  });
});

// #2706 parity: mobile's "+ pieces" carries hitSlop={8}; web grows the tap target by the same 8px
// with a pseudo-element (layout unchanged).
it("the '+ pieces' and remove-units controls carry an 8px hit-area extension", () => {
  renderRow(makeProps({ ...boxedItem, boxes: 1, pieces: 0 }));
  expect(screen.getByRole("button", { name: ADD_EXTRA })).toHaveClass(
    "relative",
    "before:-inset-2",
  );
  fireEvent.click(screen.getByRole("button", { name: ADD_EXTRA }));
  expect(screen.getByLabelText("Remove extra pieces")).toHaveClass("relative", "before:-inset-2");
});
