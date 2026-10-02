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
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
  });

  it("traps Tab within the modal, wrapping last -> first and first -> last", async () => {
    const user = userEvent.setup();
    render(<Harness open />);

    const closeButton = screen.getByRole("button", { name: "Close dialog" });
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

// A3 F9: the dialog had no accessible name (axe `aria-dialog-name`), its close button was a bare
// "×" (axe `button-name`), and a parent re-render (a new inline `onClose` per render) re-ran the
// focus effect so focus jumped to the close button after every keystroke in a controlled field.
function TypingHarness() {
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState("");
  const [closed, setClosed] = React.useState(0);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Delete tenant</button>
      <span data-testid="closed">{closed}</span>
      <AdminModal
        open={open}
        onClose={() => {
          setOpen(false);
          setClosed(closed + 1); // reads state: a stale onClose would report the OLD count
        }}
        title="Permanently delete tenant?"
      >
        <input aria-label="Tenant slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </AdminModal>
    </div>
  );
}

describe("AdminModal — naming and focus stability (A3 F9)", () => {
  it("is named by its title (aria-labelledby -> the heading)", () => {
    render(
      <AdminModal open onClose={jest.fn()} title="Confirm action">
        <button>Field</button>
      </AdminModal>,
    );
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeInTheDocument();
  });

  it("two modals on a page keep distinct label ids", () => {
    render(
      <>
        <AdminModal open onClose={jest.fn()} title="First">
          <button>a</button>
        </AdminModal>
        <AdminModal open onClose={jest.fn()} title="Second">
          <button>b</button>
        </AdminModal>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "First" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Second" })).toBeInTheDocument();
  });

  it("the close control has an accessible name and is a plain button", () => {
    render(
      <AdminModal open onClose={jest.fn()} title="Confirm action">
        <button>Field</button>
      </AdminModal>,
    );
    const close = screen.getByRole("button", { name: "Close dialog" });
    expect(close).toHaveAttribute("type", "button");
  });

  it("REPRO: typing in a controlled field keeps focus in it across parent re-renders (new inline onClose each time)", async () => {
    const user = userEvent.setup();
    render(<TypingHarness />);
    await user.click(screen.getByText("Delete tenant"));

    const input = screen.getByRole("textbox", { name: "Tenant slug" });
    await user.click(input);
    await user.keyboard("acme");

    expect(input).toHaveValue("acme");
    expect(input).toHaveFocus();
  });

  it("Escape calls the LATEST onClose after re-renders, not the one from when it opened", async () => {
    const user = userEvent.setup();
    render(<TypingHarness />);
    await user.click(screen.getByText("Delete tenant"));
    await user.click(screen.getByRole("textbox", { name: "Tenant slug" }));
    await user.keyboard("ab");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("closed")).toHaveTextContent("1");
  });

  it("focus still returns to the trigger after closing from a re-rendered modal", async () => {
    const user = userEvent.setup();
    render(<TypingHarness />);
    const trigger = screen.getByText("Delete tenant");
    await user.click(trigger);
    await user.click(screen.getByRole("textbox", { name: "Tenant slug" }));
    await user.keyboard("x{Escape}");
    expect(trigger).toHaveFocus();
  });
});
