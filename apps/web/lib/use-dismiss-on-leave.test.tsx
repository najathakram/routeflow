import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDismissOnLeave } from "./use-dismiss-on-leave";

/** W-758 MUST 1: the hook adds NO listbox semantics or key model of its own (consumers without nav stay unchanged). */
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

describe("useDismissOnLeave", () => {
  it("renders no listbox role and leaves arrows/Enter alone", () => {
    render(<Plain />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    const input = screen.getByLabelText("plain");
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(screen.getByText("list")).toBeInTheDocument();
  });

  it("Tab closes the popup", () => {
    render(<Plain />);
    fireEvent.keyDown(screen.getByLabelText("plain"), { key: "Tab" });
    expect(screen.queryByText("list")).not.toBeInTheDocument();
  });
});
