import * as React from "react";
import { act, fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import {
  setBoxesOnLines,
  setPiecesOnLines,
  setQtyOnLines,
  setUnitQtyOnLines,
} from "@/lib/line-qty-edit";
import { LineItemRow, type LineItemRowItem } from "./LineItemRow";

/**
 * SA-1256 typed sums PR 1, component level (X1-X10). A small harness owns ONE line and wires the row's handlers to
 * the order builder's real helpers (`lib/line-qty-edit.ts`, as `CreateOrderModal` does), with a jest spy around each
 * handler so call counts and arguments can be asserted. `acceptSums` is passed through a cast so this file compiles
 * before and after the prop exists.
 */

const PLAIN: LineItemRowItem = {
  tempId: "t1",
  productId: "p1",
  productName: "Sample Chips",
  unit: "each",
  listPrice: 2.5,
  unitPrice: 2.5,
  priceType: "STANDARD",
  qty: 3,
};
const BOXED: LineItemRowItem = {
  ...PLAIN,
  unit: "case",
  listPrice: 30,
  unitPrice: 30,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  qty: 24,
  sellBy: "case",
};

type Edit = (lines: LineItemRowItem[], tempId: string, value: number) => LineItemRowItem[];
type Spies = Record<"setQty" | "setBoxes" | "setPieces" | "setUnitQty", jest.Mock>;
interface Rig {
  spies: Spies;
  line: LineItemRowItem;
  setLine: React.Dispatch<React.SetStateAction<LineItemRowItem>>;
}
const makeRig = (): Rig => ({
  spies: {
    setQty: jest.fn(),
    setBoxes: jest.fn(),
    setPieces: jest.fn(),
    setUnitQty: jest.fn(),
  },
  line: PLAIN,
  setLine: () => undefined,
});

function Harness({
  rig,
  start,
  acceptSums,
  locked,
}: {
  rig: Rig;
  start: LineItemRowItem;
  acceptSums?: boolean;
  locked?: boolean;
}) {
  const [line, setLine] = React.useState(start);
  rig.line = line;
  rig.setLine = setLine;
  const wire = (spy: jest.Mock, edit: Edit) => (n: number) => {
    spy(n);
    setLine((prev) => edit([prev], prev.tempId, n)[0]);
  };
  const sums = { acceptSums } as object;
  return (
    <ul>
      <LineItemRow
        item={line}
        marginFloor={0}
        floorAcked={false}
        costRevealed={false}
        locked={locked}
        onQtyDelta={jest.fn()}
        onSetBoxes={wire(rig.spies.setBoxes, setBoxesOnLines)}
        onSetPieces={wire(rig.spies.setPieces, setPiecesOnLines)}
        onSetUnitQty={wire(rig.spies.setUnitQty, setUnitQtyOnLines)}
        onSetSellBy={jest.fn()}
        onSetDiscountedPrice={jest.fn()}
        onSetToFloor={jest.fn()}
        onAckFloor={jest.fn()}
        onToggleCostRevealed={jest.fn()}
        onToggleNoteOpen={jest.fn()}
        onSetNote={jest.fn()}
        onUpdateUnlistedName={jest.fn()}
        onUpdateUnlistedPrice={jest.fn()}
        onRemove={jest.fn()}
        onSetQty={wire(rig.spies.setQty, setQtyOnLines)}
        {...sums}
      />
    </ul>
  );
}

interface Mode {
  name: string;
  start: LineItemRowItem;
  spy: keyof Spies;
  box: () => HTMLInputElement;
  value: (l: LineItemRowItem) => number;
  /** The line's own number moved by one (a parent change under a held sum). */
  bump: (l: LineItemRowItem) => LineItemRowItem;
  /** The number the box holds when it takes focus. */
  focusValue: number;
  /** What an emptied box passes to the handler today (parseInt gives NaN; the unit-total box says 0). */
  emptyCall: number;
}
const MODES: Mode[] = [
  {
    name: "plain quantity",
    start: PLAIN,
    spy: "setQty",
    box: () => screen.getByRole("spinbutton", { name: "Quantity" }) as HTMLInputElement,
    value: (l) => l.qty,
    bump: (l) => ({ ...l, qty: l.qty + 1 }),
    focusValue: 3,
    emptyCall: NaN,
  },
  {
    name: "boxes",
    start: { ...BOXED, boxes: 2, qty: 48 },
    spy: "setBoxes",
    box: () => screen.getByTitle(/number of whole/i) as HTMLInputElement,
    value: (l) => l.boxes ?? 0,
    bump: (l) => ({ ...l, boxes: (l.boxes ?? 0) + 1, qty: l.qty + 24 }),
    focusValue: 2,
    emptyCall: NaN,
  },
  {
    name: "pieces",
    start: { ...BOXED, pieces: 5, qty: 29 },
    spy: "setPieces",
    box: () => screen.getByLabelText(/^extra /i) as HTMLInputElement,
    value: (l) => l.pieces ?? 0,
    bump: (l) => ({ ...l, pieces: (l.pieces ?? 0) + 1, qty: l.qty + 1 }),
    focusValue: 5,
    emptyCall: NaN,
  },
  {
    name: "unit total",
    start: { ...BOXED, sellBy: "unit", boxes: 1, pieces: 6, qty: 30 },
    spy: "setUnitQty",
    box: () => screen.getByTitle(/^Total /) as HTMLInputElement,
    value: (l) => l.qty,
    bump: (l) => ({ ...l, qty: l.qty + 1, pieces: (l.pieces ?? 0) + 1 }),
    focusValue: 30,
    emptyCall: 0,
  },
];

const typeText = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
/** Returns false when the key's default was prevented (the form's chord checks `defaultPrevented`). */
const press = (el: HTMLElement, key: string) => fireEvent.keyDown(el, { key });
const calls = (rig: Rig, spy: keyof Spies) => rig.spies[spy].mock.calls.map((c) => c[0]);

function mount(mode: Mode, opts: { acceptSums?: boolean; locked?: boolean } = {}) {
  const rig = makeRig();
  const view = renderWithProviders(
    <Harness rig={rig} start={mode.start} acceptSums={opts.acceptSums} locked={opts.locked} />,
  );
  const rerender = (o: { acceptSums?: boolean; locked?: boolean }) =>
    view.rerender(<Harness rig={rig} start={mode.start} {...o} />);
  // The element is kept: a box that a wrong value makes vanish (pieces at 0) must not turn a pin into a lookup error.
  const el = mode.box();
  return { rig, view, rerender, box: () => el };
}

describe("LineItemRow typed sums (SA-1256 X1-X10)", () => {
  describe.each(MODES)("$name box", (mode) => {
    const on = { acceptSums: true };

    it("X1: digits commit on every keystroke, as today", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "1");
      typeText(box(), "12");
      expect(calls(rig, mode.spy)).toEqual([1, 12]);
      expect(box().value).toBe("12");
    });

    it("X2: a held 5*2 makes no call, shows the result, and Enter commits one 10 and keeps the form from submitting", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      expect(calls(rig, mode.spy)).toEqual([]);
      const status = screen.getByText("= 10 · press Enter");
      expect(status).toHaveAttribute("role", "status");
      expect(box()).toHaveAttribute("data-qty-held");
      expect(box().value).toBe("5*2");
      const notPrevented = press(box(), "Enter");
      expect(notPrevented).toBe(false);
      expect(calls(rig, mode.spy)).toEqual([10]);
      expect(mode.value(rig.line)).toBe(10);
      expect(box()).not.toHaveAttribute("data-qty-held");
    });

    it("X2: Tab (blur) commits the held sum once", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      fireEvent.blur(box());
      expect(calls(rig, mode.spy)).toEqual([10]);
      expect(mode.value(rig.line)).toBe(10);
    });

    it("X2: Enter followed by blur is still one call", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      press(box(), "Enter");
      fireEvent.blur(box());
      expect(calls(rig, mode.spy)).toEqual([10]);
    });

    it("X2: typing 5 then 5* then 5*2 calls once for the 5, holds the rest, Enter adds one 10", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      // A box that already holds 5 gets no change event for a typed "5": there is nothing to commit.
      const five = mode.focusValue === 5 ? [] : [5];
      typeText(box(), "5");
      expect(calls(rig, mode.spy)).toEqual(five);
      typeText(box(), "5*");
      typeText(box(), "5*2");
      expect(calls(rig, mode.spy)).toEqual(five);
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([...five, 10]);
      expect(mode.value(rig.line)).toBe(10);
    });

    it("X3: 24/0 then Enter puts back the focus-time value and says the sum is not valid", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      for (const t of ["2", "24", "24/", "24/0"]) typeText(box(), t);
      press(box(), "Enter");
      // A box that already holds 2 gets no change event for the typed "2".
      const two = mode.focusValue === 2 ? [] : [2];
      expect(calls(rig, mode.spy)).toEqual([...two, 24, mode.focusValue]);
      expect(mode.value(rig.line)).toBe(mode.focusValue);
      expect(screen.getByRole("alert")).toHaveTextContent("Sum not valid. Quantity not changed.");
    });

    it("X3: a sum refused after Enter settled an earlier one puts back the settled value, not an older one", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      press(box(), "Enter"); // 10; the box keeps focus, so there is no second focus event
      typeText(box(), "5/2");
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([10]);
      expect(mode.value(rig.line)).toBe(10);
      expect(screen.getByRole("alert")).toHaveTextContent("Not a whole number. Not changed.");
    });

    it("X3: Enter settles plain digits too, so a sum refused afterwards puts those digits back", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "8");
      press(box(), "Enter");
      for (const t of ["2", "24", "24/", "24/0"]) typeText(box(), t);
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([8, 2, 24, 8]);
      expect(mode.value(rig.line)).toBe(8);
      expect(screen.getByRole("alert")).toHaveTextContent("Sum not valid. Quantity not changed.");
    });

    it.each(["1,000", "12]", "3a"])("X4: pasted %s is held, then refused with no call", (text) => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), text);
      expect(calls(rig, mode.spy)).toEqual([]);
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(mode.value(rig.line)).toBe(mode.focusValue);
      expect(screen.getByRole("alert")).toHaveTextContent("Sum not valid. Quantity not changed.");
    });

    it("X4: pasted 2.5 is held, then refused with no call", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "2.5");
      expect(calls(rig, mode.spy)).toEqual([]);
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(mode.value(rig.line)).toBe(mode.focusValue);
      expect(screen.getByRole("alert")).toHaveTextContent(/Sum not valid|Not a whole number/);
    });

    it("X5: a held sum is dropped when the line's number changes under it", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      act(() => rig.setLine(mode.bump));
      expect(box().value).toBe(String(mode.focusValue + 1));
      expect(box()).not.toHaveAttribute("data-qty-held");
      press(box(), "Enter");
      fireEvent.blur(box());
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(mode.value(rig.line)).toBe(mode.focusValue + 1);
    });

    it("a refusal message goes away once the line's number moves again", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5/2");
      press(box(), "Enter");
      expect(screen.getByRole("alert")).toHaveTextContent("Not a whole number. Not changed.");
      act(() => rig.setLine(mode.bump));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a held sum is read out as typed (aria-valuetext), the committed number stays in aria-valuenow", () => {
      const { box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      expect(box()).toHaveAttribute("aria-valuetext", "5*2");
      expect(box()).toHaveAttribute("aria-valuenow", String(mode.focusValue));
      press(box(), "Enter");
      expect(box()).not.toHaveAttribute("aria-valuetext");
    });

    it("X6: Escape drops held text, puts the focus-time value back, no call and no message", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      press(box(), "Escape");
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(box().value).toBe(String(mode.focusValue));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(box()).not.toHaveAttribute("data-qty-held");
    });

    it("X6: a box that becomes disabled under a held sum commits nothing", () => {
      const { rig, rerender, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      rerender({ acceptSums: true, locked: true });
      expect(box()).toBeDisabled();
      press(box(), "Enter");
      fireEvent.blur(box());
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(mode.value(rig.line)).toBe(mode.focusValue);
    });

    it("X8: spinbutton role, text type, numeric keyboard; ArrowUp steps by one", () => {
      const { rig, box } = mount(mode, on);
      expect(box()).toHaveAttribute("role", "spinbutton");
      expect(box()).toHaveAttribute("type", "text");
      expect(box()).toHaveAttribute("inputmode", "numeric");
      fireEvent.focus(box());
      press(box(), "ArrowUp");
      expect(calls(rig, mode.spy)).toEqual([mode.focusValue + 1]);
    });

    it("X8: ArrowUp and ArrowDown do nothing while text is held", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      typeText(box(), "5*2");
      press(box(), "ArrowUp");
      press(box(), "ArrowDown");
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(box().value).toBe("5*2");
    });

    it("X9: a scanner burst AB-12 then Enter commits nothing and leaves the line alone", () => {
      const { rig, box } = mount(mode, on);
      fireEvent.focus(box());
      for (const t of ["A", "AB", "AB-", "AB-1", "AB-12"]) typeText(box(), t);
      press(box(), "Enter");
      expect(calls(rig, mode.spy)).toEqual([]);
      expect(rig.line).toEqual(mode.start);
    });

    it("X9: a digits-only burst then Enter makes the same calls as with acceptSums off", () => {
      const run = (acceptSums: boolean) => {
        const m = mount(mode, { acceptSums });
        fireEvent.focus(m.box());
        for (const t of ["4", "45", "456"]) typeText(m.box(), t);
        press(m.box(), "Enter");
        const out = { calls: calls(m.rig, mode.spy), line: m.rig.line };
        m.view.unmount();
        return out;
      };
      const master = run(false);
      expect(master.calls).toEqual([4, 45, 456]);
      expect(run(true)).toEqual(master);
    });

    it("X10: an emptied box then blur is exactly what it is without acceptSums", () => {
      const run = (acceptSums: boolean) => {
        const m = mount(mode, { acceptSums });
        if (acceptSums) expect(m.box()).toHaveAttribute("type", "text");
        fireEvent.focus(m.box());
        typeText(m.box(), "");
        const mid = m.box().value;
        fireEvent.blur(m.box());
        const out = {
          calls: calls(m.rig, mode.spy),
          mid,
          shown: m.box().value,
          line: m.rig.line,
        };
        m.view.unmount();
        return out;
      };
      const master = run(false);
      expect(master.calls).toEqual([mode.emptyCall]);
      expect(run(true)).toEqual(master);
    });

    it("default off: the box is type=number", () => {
      mount(mode);
      expect(mode.box()).toHaveAttribute("type", "number");
    });
  });

  describe("plain quantity box refusals and minimum", () => {
    const plain = MODES[0];
    it.each([
      ["2-2", "Must be at least 1. Not changed."],
      ["1-5", "Must be at least 1. Not changed."],
      ["5/2", "Not a whole number. Not changed."],
      ["999*999", "Too big. The most is 100,000."],
    ])("%s is refused with its own message and the quantity stays 3", (text, message) => {
      const { rig, box } = mount(plain, { acceptSums: true });
      fireEvent.focus(box());
      typeText(box(), text);
      press(box(), "Enter");
      expect(calls(rig, "setQty")).toEqual([]);
      expect(rig.line.qty).toBe(3);
      expect(screen.getByRole("alert")).toHaveTextContent(message);
    });

    it("X10: the F08 note after typing 0 is the same as with acceptSums off", () => {
      const run = (acceptSums: boolean) => {
        const m = mount(plain, { acceptSums });
        if (acceptSums) expect(m.box()).toHaveAttribute("type", "text");
        fireEvent.focus(m.box());
        typeText(m.box(), "0");
        const out = {
          calls: calls(m.rig, "setQty"),
          note: screen.queryByText(/Quantity must be at least 1/i)?.textContent ?? null,
          line: m.rig.line,
        };
        m.view.unmount();
        return out;
      };
      const master = run(false);
      expect(master.calls).toEqual([0]);
      expect(master.note).toBe("Quantity must be at least 1. Remove the line to drop it.");
      expect(run(true)).toEqual(master);
    });
  });

  describe("boxes have a minimum of 0", () => {
    it("2-2 works out to 0 and is committed, not refused", () => {
      const boxes = MODES[1];
      const { rig, box } = mount(boxes, { acceptSums: true });
      fireEvent.focus(box());
      typeText(box(), "2-2");
      press(box(), "Enter");
      expect(calls(rig, "setBoxes")).toEqual([0]);
      expect(rig.line.boxes).toBe(0);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("X5: boxes and pieces are one line quantity", () => {
    type Move = (l: LineItemRowItem) => LineItemRowItem;
    const morePieces: Move = (l) => ({ ...l, pieces: (l.pieces ?? 0) + 1, qty: l.qty + 1 });
    const moreBoxes: Move = (l) => ({ ...l, boxes: (l.boxes ?? 0) + 1, qty: l.qty + 24 });
    it.each([
      ["boxes", MODES[1], morePieces],
      ["pieces", MODES[2], moreBoxes],
    ] as const)(
      "a sum held in the %s box is dropped when the other box moves",
      (_name, mode, other) => {
        const { rig, box } = mount(mode, { acceptSums: true });
        fireEvent.focus(box());
        typeText(box(), "5*2");
        act(() => rig.setLine(other));
        expect(box()).not.toHaveAttribute("data-qty-held");
        press(box(), "Enter");
        fireEvent.blur(box());
        expect(calls(rig, mode.spy)).toEqual([]);
        expect(mode.value(rig.line)).toBe(mode.focusValue);
      },
    );
  });

  describe("X7-prime: pieces on a 24-per-box line stay as master has them", () => {
    const run = (acceptSums: boolean, steps: string[], enter: boolean) => {
      const rig = makeRig();
      const view = renderWithProviders(<Harness rig={rig} start={BOXED} acceptSums={acceptSums} />);
      fireEvent.click(screen.getByRole("button", { name: /add extra/i }));
      const box = () => screen.getByLabelText(/^extra /i);
      fireEvent.focus(box());
      for (const s of steps) typeText(box(), s);
      if (enter) press(box(), "Enter");
      const { boxes, pieces, qty } = rig.line;
      view.unmount();
      return { boxes, pieces, qty };
    };

    it("typing 30 plain, and typing 6*5 then Enter, end at master's line", () => {
      const master = run(false, ["3", "30"], false);
      expect(master).toEqual({ boxes: 1, pieces: 30, qty: 54 });
      expect(run(true, ["3", "30"], false)).toEqual(master);
      expect(run(true, ["6*5"], true)).toEqual(master);
    });
  });

  describe("default off: every quantity input is type=number", () => {
    it("a plain line", () => {
      mount(MODES[0]);
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute(
        "type",
        "number",
      );
    });
    it("a boxed line, boxes and pieces", () => {
      mount(MODES[2]);
      expect(MODES[1].box()).toHaveAttribute("type", "number");
      expect(MODES[2].box()).toHaveAttribute("type", "number");
    });
  });
});

/**
 * R-121 findings 1 and 2. An emptied boxes or pieces box keeps its own "cleared" flag, which only the box's own
 * handler resets, so a sum's result, an Esc or a refusal must go back through that handler (ruling 6: "as String(n)
 * into the existing handlers"), or the box shows empty beside a line that holds the number.
 */
describe("R-121: boxes and pieces boxes show the number after a sum, Esc or a refusal", () => {
  const on = { acceptSums: true };
  /** Boxes: the box under test starts at `boxes`. Pieces: opened with "+ units", set to 3, blurred, so 3 is the number at focus. */
  const FIELDS = [
    {
      name: "boxes",
      atFocus: 2,
      open: () => {
        const m = mount({ ...MODES[1], start: { ...BOXED, boxes: 2, qty: 48 } }, on);
        return { ...m, field: m.box };
      },
      value: (l: LineItemRowItem) => l.boxes ?? 0,
    },
    {
      name: "pieces",
      atFocus: 3,
      open: () => {
        const rig = makeRig();
        renderWithProviders(<Harness rig={rig} start={{ ...BOXED, pieces: 0 }} acceptSums />);
        fireEvent.click(screen.getByRole("button", { name: /add extra/i }));
        const el = () => screen.getByLabelText(/^extra /i) as HTMLInputElement;
        fireEvent.focus(el());
        typeText(el(), "3");
        fireEvent.blur(el());
        return { rig, field: el };
      },
      value: (l: LineItemRowItem) => l.pieces ?? 0,
    },
  ];

  describe.each(FIELDS)("$name box", (f) => {
    it("emptied, then (1+1)*3 and Enter: the line takes 6 and the box shows 6", () => {
      const { rig, field } = f.open();
      fireEvent.focus(field());
      typeText(field(), "");
      typeText(field(), "(1+1)*3");
      press(field(), "Enter");
      expect(f.value(rig.line)).toBe(6);
      expect(field().value).toBe("6");
    });

    it("emptied, then (2)*5 and Esc: the line goes back to the number at focus and the box shows it", () => {
      const { rig, field } = f.open();
      fireEvent.focus(field());
      typeText(field(), "");
      typeText(field(), "(2)*5");
      press(field(), "Escape");
      expect(f.value(rig.line)).toBe(f.atFocus);
      expect(field().value).toBe(String(f.atFocus));
    });

    it("emptied, then a refused sum and Enter: the box shows the number put back, beside the note", () => {
      const { rig, field } = f.open();
      fireEvent.focus(field());
      typeText(field(), "");
      typeText(field(), "(1)/2");
      press(field(), "Enter");
      expect(f.value(rig.line)).toBe(f.atFocus);
      expect(field().value).toBe(String(f.atFocus));
      expect(screen.getByRole("alert")).toHaveTextContent("Not a whole number. Not changed.");
    });
  });

  it("boxes emptied from 0, then a held sum and Esc: the box shows 0, the number at focus", () => {
    const { rig, box } = mount({ ...MODES[1], start: { ...BOXED, boxes: 0, qty: 0 } }, on);
    fireEvent.focus(box());
    typeText(box(), "");
    typeText(box(), "(2)*5");
    press(box(), "Escape");
    expect(rig.line.boxes).toBe(0);
    expect(box().value).toBe("0");
  });

  it("a refusal note stays hidden after the number moves and comes back to the refused number", () => {
    const mode = MODES[0];
    const { box } = mount(mode, on);
    fireEvent.focus(box());
    typeText(box(), "5/2");
    press(box(), "Enter");
    expect(screen.getByRole("alert")).toHaveTextContent("Not a whole number. Not changed.");
    press(box(), "ArrowUp");
    expect(screen.queryByRole("alert")).toBeNull();
    press(box(), "ArrowDown");
    expect(box().value).toBe("3");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
