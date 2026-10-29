import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useListboxNav } from "./use-listbox-nav";

/** W-758: keys pressed while an IME is composing (isComposing / keyCode 229) belong to the IME, never to the list. */
function Harness({ onPick }: { onPick: (s: string) => void }) {
  const nav = useListboxNav({ items: ["a", "b"], open: true, onPick, idPrefix: "t" });
  return <input aria-label="search" {...nav.inputProps} onKeyDown={nav.onKeyDown} />;
}

describe("useListboxNav IME composition guard", () => {
  it("ignores ArrowDown while composing", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("search");
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("ignores Enter with keyCode 229 and leaves it unconsumed", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByLabelText("search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onPick).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});
