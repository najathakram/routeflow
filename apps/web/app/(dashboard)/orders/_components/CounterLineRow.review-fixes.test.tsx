import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";
import { setLineQty } from "./counter-sale-line-edit";
import { QTY_ZERO_BOXED_COPY } from "./counter-qty-refusal";

/**
 * B1373 review (Opus Tier 2): the till rules the order row must not lose.
 * H1: the order row keeps a note's field on screen while it has text, so Escape puts back the note as it was when the
 *     field took focus. It must never put back "" over a note the clerk saved earlier, or over the note of a remounted row.
 * M2: every refused typed quantity says why on the line (a boxed line's 0 boxes and 0 pieces), not only the cap.
 */
const plain: SaleLine = {
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 2.5,
  qty: 3,
  note: "smoke note",
};

function renderRow(
  line: SaleLine,
  over: Partial<React.ComponentProps<typeof CounterLineRow>> = {},
) {
  const onNote = jest.fn();
  const onNoteClosed = jest.fn();
  const onQty = jest.fn((_id: string, typed) => setLineQty(line, typed) !== null);
  render(
    <ul>
      <CounterLineRow
        line={line}
        locked={false}
        onStep={() => undefined}
        onRemove={() => undefined}
        onNote={onNote}
        onNoteClosed={onNoteClosed}
        onQty={onQty}
        {...over}
      />
    </ul>,
  );
  return { onNote, onNoteClosed, onQty };
}

describe("CounterLineRow note Escape (H1)", () => {
  it("a saved note shown on a fresh row: focus, edit, Escape puts the saved note back (never empties it)", () => {
    const { onNote, onNoteClosed } = renderRow(plain);
    const note = screen.getByRole("textbox", { name: "Note for Cola" });
    expect(note).toHaveValue("smoke note");
    note.focus(); // a real focus (the row records the note Escape puts back)
    fireEvent.change(note, { target: { value: "smoke note, extra ice" } });
    fireEvent.keyDown(note, { key: "Escape" });
    expect(onNote).toHaveBeenLastCalledWith("t1", "smoke note");
    expect(onNote).not.toHaveBeenCalledWith("t1", "");
    expect(onNoteClosed).toHaveBeenCalled();
  });

  it("a new note opened from the toggle: Escape puts back the empty note it started from", () => {
    const { onNote } = renderRow({ ...plain, note: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Add a note to Cola" }));
    const note = screen.getByRole("textbox", { name: "Note for Cola" });
    expect(note).toHaveFocus();
    fireEvent.keyDown(note, { key: "Escape" });
    expect(onNote).toHaveBeenLastCalledWith("t1", "");
  });
});

describe("CounterLineRow boxed refusals (M2)", () => {
  const boxed: SaleLine = {
    tempId: "t2",
    productId: "p2",
    name: "Gum",
    unitPrice: 24,
    unitsPerBox: 24,
    boxes: 1,
    pieces: 0,
    qty: 24,
  };

  it("0 boxes with 0 pieces is refused and the line says why", () => {
    const { onQty } = renderRow(boxed);
    const boxes = screen.getByTitle("Number of whole boxes");
    fireEvent.change(boxes, { target: { value: "0" } });
    fireEvent.blur(boxes);
    expect(onQty).toHaveBeenCalledWith("t2", { boxes: "0" });
    expect(screen.getByRole("alert")).toHaveTextContent(QTY_ZERO_BOXED_COPY);
  });
});
