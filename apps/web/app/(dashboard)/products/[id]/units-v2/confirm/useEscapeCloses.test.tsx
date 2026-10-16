import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useEscapeCloses } from "./useEscapeCloses";

function Panel({ name }: { name: string }) {
  const [open, setOpen] = React.useState(false);
  const opener = React.useRef<HTMLButtonElement>(null);
  useEscapeCloses(open, () => setOpen(false), opener);
  return (
    <div>
      <button ref={opener} onClick={() => setOpen(true)}>
        open {name}
      </button>
      {open ? <div role="dialog" aria-label={name} /> : null}
    </div>
  );
}

const esc = () => fireEvent.keyDown(document, { key: "Escape" });

describe("useEscapeCloses (V17)", () => {
  it("closes only the topmost of two stacked panels and returns focus to its opener", () => {
    render(
      <>
        <Panel name="first" />
        <Panel name="second" />
      </>,
    );
    fireEvent.click(screen.getByText("open first"));
    fireEvent.click(screen.getByText("open second"));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    esc();
    expect(screen.queryByRole("dialog", { name: "second" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "first" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByText("open second"));

    esc();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("open first"));
  });

  it("does nothing when no panel is open", () => {
    render(<Panel name="only" />);
    esc();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
