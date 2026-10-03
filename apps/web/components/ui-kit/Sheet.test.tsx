import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sheet } from "@routeflow/ui/web";
import { mockReducedMotion } from "./matchMedia";

beforeEach(() => mockReducedMotion(false));

function Harness() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Box or piece?" description="Pick one">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("opens as a labelled modal dialog and focus moves inside", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dlg = await screen.findByRole("dialog", { name: "Box or piece?" });
    expect(dlg).toBeInTheDocument();
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(dlg).toHaveAccessibleDescription("Pick one");
  });

  it("Tab cycles inside the sheet (trap)", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dlg = await screen.findByRole("dialog");
    for (let i = 0; i < 8; i++) {
      await userEvent.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it("Escape closes and focus returns to the trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("locks body scroll while open", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    expect(document.body.style.pointerEvents).toBe("none");
    expect(document.body.getAttribute("data-scroll-locked")).not.toBeNull();
  });

  it("initialFocus is honoured", async () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Sheet open onOpenChange={() => {}} title="T" initialFocus={ref}>
        <button type="button">First</button>
        <button type="button" ref={ref}>
          Second
        </button>
      </Sheet>,
    );
    await screen.findByRole("dialog");
    expect(screen.getByText("Second")).toHaveFocus();
  });
});
