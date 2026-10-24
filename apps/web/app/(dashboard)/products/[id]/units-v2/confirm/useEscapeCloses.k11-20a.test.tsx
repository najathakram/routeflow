import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { closeTopEscapePanel, hasOpenEscapePanel, useEscapeCloses } from "./useEscapeCloses";

// K11-20a: the floating price window handles Escape itself (Radix listens first), so it needs to close the top panel
// by hand. closeTopEscapePanel does what the stack's own Escape does: close the newest panel, focus its opener.

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

describe("closeTopEscapePanel", () => {
  it("closes only the topmost panel and focuses its opener, and says it did", () => {
    render(
      <>
        <Panel name="first" />
        <Panel name="second" />
      </>,
    );
    fireEvent.click(screen.getByText("open first"));
    fireEvent.click(screen.getByText("open second"));
    let closed: boolean | undefined;
    act(() => {
      closed = closeTopEscapePanel();
    });
    expect(closed).toBe(true);
    expect(screen.queryByRole("dialog", { name: "second" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "first" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByText("open second"));
    act(() => {
      closeTopEscapePanel();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("open first"));
    expect(hasOpenEscapePanel()).toBe(false);
  });

  it("does nothing, and returns false, when no panel is open", () => {
    render(<Panel name="only" />);
    let closed: boolean | undefined;
    act(() => {
      closed = closeTopEscapePanel();
    });
    expect(closed).toBe(false);
  });
});
