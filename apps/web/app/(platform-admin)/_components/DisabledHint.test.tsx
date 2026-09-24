import * as React from "react";
import { render, screen } from "@testing-library/react";
import { DisabledHint } from "./DisabledHint";

// A3 F8: a disabled control gives a keyboard / screen-reader user no reason on its own.
function Harness({ blocked }: { blocked: boolean }) {
  return (
    <div>
      <button disabled={blocked} aria-describedby={blocked ? "why" : undefined}>
        Export
      </button>
      <DisabledHint id="why" show={blocked}>
        Nothing to export.
      </DisabledHint>
    </div>
  );
}

describe("DisabledHint", () => {
  it("renders the reason and the disabled control is described by it", () => {
    render(<Harness blocked />);
    const btn = screen.getByRole("button", { name: "Export" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription("Nothing to export.");
  });

  it("renders nothing (and no dangling description) once the control is enabled", () => {
    render(<Harness blocked={false} />);
    expect(screen.queryByText("Nothing to export.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).not.toHaveAttribute("aria-describedby");
  });
});
