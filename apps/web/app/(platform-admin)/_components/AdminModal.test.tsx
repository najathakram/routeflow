import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminModal } from "./AdminModal";

function Harness({ open: initialOpen }: { open: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open modal</button>
      <AdminModal open={open} onClose={() => setOpen(false)} title="Confirm action">
        <button>First field</button>
        <button>Second field</button>
      </AdminModal>
    </div>
  );
}

describe("AdminModal — accessibility", () => {
  it("exposes role=dialog and aria-modal=true", () => {
    render(
      <AdminModal open onClose={jest.fn()} title="Confirm action">
        <button>Field</button>
      </AdminModal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the modal on open, to its first focusable element", async () => {
    const user = userEvent.setup();
    render(<Harness open={false} />);

    await user.click(screen.getByText("Open modal"));

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(screen.getByText("×")).toHaveFocus();
  });

  it("traps Tab within the modal, wrapping last -> first and first -> last", async () => {
    const user = userEvent.setup();
    render(<Harness open />);

    const closeButton = screen.getByText("×");
    const first = screen.getByText("First field");
    const second = screen.getByText("Second field");

    expect(closeButton).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();

    await user.tab();
    expect(second).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(second).toHaveFocus();

    await user.tab({ shift: true });
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(closeButton).toHaveFocus();
  });

  it("returns focus to the triggering element on close", async () => {
    const user = userEvent.setup();
    render(<Harness open={false} />);

    const trigger = screen.getByText("Open modal");
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
