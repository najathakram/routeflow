import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useListboxNav } from "./use-listbox-nav";

/** The combobox points at its listbox (aria-controls) only while the list exists; a closed list leaves a dangling reference. */
function Harness({ open }: { open: boolean }) {
  const nav = useListboxNav({
    items: ["a", "b"],
    open,
    onPick: () => undefined,
    onClose: () => undefined,
    idPrefix: "t",
  });
  return <input aria-label="search" {...nav.inputProps} onKeyDown={nav.onKeyDown} />;
}

describe("useListboxNav input aria", () => {
  it("has no aria-controls while the list is closed", () => {
    render(<Harness open={false} />);
    expect(screen.getByLabelText("search")).not.toHaveAttribute("aria-controls");
    expect(screen.getByLabelText("search")).toHaveAttribute("aria-expanded", "false");
  });

  it("points aria-controls at the list while it is open", () => {
    render(<Harness open />);
    expect(screen.getByLabelText("search")).toHaveAttribute("aria-controls");
    expect(screen.getByLabelText("search")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByLabelText("search"), { key: "ArrowDown" });
  });
});
