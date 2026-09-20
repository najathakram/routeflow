import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BlockedLinesDialog } from "./BlockedLinesDialog";

const lines = [
  {
    productId: "uuid-1",
    productName: "Hemp Gummies",
    categoryName: "Hemp",
    ruleId: "r1",
    reason: "STATE_BAN" as const,
    state: "TX",
    message: "m",
  },
  {
    productId: "uuid-2",
    productName: "Vape Pen",
    ruleId: null,
    reason: "INDETERMINATE_ADDRESS" as const,
    message: "m",
  },
];

describe("BlockedLinesDialog", () => {
  it("lists each blocked item with its category and a plain cause, never a raw id", () => {
    render(<BlockedLinesDialog lines={lines} onClose={jest.fn()} />);
    expect(
      screen.getByRole("dialog", { name: /can't be sold to this customer/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Hemp Gummies")).toBeInTheDocument();
    expect(screen.getByText("Hemp")).toBeInTheDocument();
    expect(screen.getByText("Restricted in TX")).toBeInTheDocument();
    expect(screen.getByText(/default address with a state/)).toBeInTheDocument();
    expect(screen.queryByText(/uuid-/)).toBeNull();
  });

  it("renders nothing when there are no lines, and OK closes it", () => {
    const onClose = jest.fn();
    const { rerender } = render(<BlockedLinesDialog lines={null} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<BlockedLinesDialog lines={lines} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onClose).toHaveBeenCalled();
  });

  describe("focus return", () => {
    // Opened by an error handler (no Radix trigger): closing must hand focus back to whatever had
    // it, not drop it on <body>.
    function Host() {
      const [open, setOpen] = React.useState<typeof lines | null>(null);
      return (
        <>
          <button onClick={() => setOpen(lines)}>Save</button>
          <BlockedLinesDialog lines={open} onClose={() => setOpen(null)} />
        </>
      );
    }
    const openIt = () => {
      render(<Host />);
      const save = screen.getByRole("button", { name: "Save" });
      save.focus();
      fireEvent.click(save);
      return save;
    };

    it("OK returns focus to the control that had it", async () => {
      const save = openIt();
      fireEvent.click(await screen.findByRole("button", { name: "OK" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(save).toHaveFocus());
    });

    it("Escape returns focus to the control that had it", async () => {
      const save = openIt();
      fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(save).toHaveFocus());
    });
  });
});
