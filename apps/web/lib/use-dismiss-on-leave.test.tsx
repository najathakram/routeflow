import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDismissOnLeave } from "./use-dismiss-on-leave";

/**
 * W-758: keyboard navigation in the shared popup behaviour. ArrowDown/ArrowUp move a highlight over the options,
 * Enter picks the highlighted one, Escape and Tab close, and the highlight resets whenever the popup closes or the
 * option list changes. Without a highlight Enter is left alone (a form's own Enter still works).
 */

const ITEMS = ["Mint Pod", "Mango Pod", "Mocha Pod"];

function Harness({ onPick }: { onPick: (i: number) => void }) {
  const [open, setOpen] = React.useState(true);
  const leave = useDismissOnLeave(setOpen, { open, count: ITEMS.length, onPick });
  return (
    <div>
      <input aria-label="search" onFocus={() => setOpen(true)} {...leave.inputProps} />
      {open && (
        <div {...leave.listProps}>
          {ITEMS.map((name, i) => (
            <button key={name} type="button" {...leave.optionProps(i)}>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const selected = () =>
  screen
    .queryAllByRole("option")
    .filter((o) => o.getAttribute("aria-selected") === "true")
    .map((o) => o.textContent);

describe("useDismissOnLeave keyboard navigation (W-758)", () => {
  it("starts with nothing highlighted; ArrowDown highlights the first, then the next, and stops at the last", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("search");
    expect(selected()).toEqual([]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toEqual(["Mint Pod"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toEqual(["Mango Pod"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toEqual(["Mocha Pod"]);
  });

  it("ArrowUp moves back and stops at the first", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toEqual(["Mint Pod"]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toEqual(["Mint Pod"]);
  });

  it("Enter picks the highlighted option and is consumed", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByLabelText("search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const consumed = !fireEvent.keyDown(input, { key: "Enter" }); // false returned = default prevented
    expect(onPick).toHaveBeenCalledWith(1);
    expect(consumed).toBe(true);
  });

  it("Enter with nothing highlighted is left alone", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("search"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("Escape closes the popup", () => {
    render(<Harness onPick={jest.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("search"), { key: "Escape" });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("the highlight resets after the popup closes and reopens", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.focus(input);
    expect(selected()).toEqual([]);
  });

  it("hovering an option highlights it, so the mouse and the keys share one highlight", () => {
    render(<Harness onPick={jest.fn()} />);
    fireEvent.mouseEnter(screen.getByRole("option", { name: "Mocha Pod" }));
    expect(selected()).toEqual(["Mocha Pod"]);
  });

  it("without the nav argument the hook keeps its Tab/blur behaviour and ignores arrows", () => {
    function Plain() {
      const [open, setOpen] = React.useState(true);
      const leave = useDismissOnLeave(setOpen);
      return (
        <div>
          <input aria-label="plain" {...leave.inputProps} />
          {open && <div {...leave.listProps}>list</div>}
        </div>
      );
    }
    render(<Plain />);
    const input = screen.getByLabelText("plain");
    const notPrevented = fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(notPrevented).toBe(true);
    expect(screen.getByText("list")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByText("list")).not.toBeInTheDocument();
  });
});
