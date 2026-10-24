import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

let mockHasAddon = true;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => mockHasAddon }));
jest.mock("../../../returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: { open: boolean; orderId?: string }) =>
    p.open ? <div data-testid="return-dialog">{p.orderId}</div> : null,
}));

import { useOrderOverpayGuard } from "./OrderOverpayNotice";

const err = {
  response: {
    status: 409,
    data: { code: "ORDER_EDIT_WOULD_OVERPAY", message: "RAW SERVER TEXT", excess: 20 },
  },
};

function Harness({ error, editing = true }: { error: unknown; editing?: boolean }) {
  const guard = useOrderOverpayGuard(
    {
      id: "o1",
      customerId: "c1",
      customer: { businessName: "Acme" },
    },
    editing,
  );
  return (
    <div>
      <button onClick={() => guard.capture(error)}>go</button>
      {guard.node}
    </div>
  );
}

describe("useOrderOverpayGuard", () => {
  // Row 313: the notice renders near the line items, far above Save on a long order, so a refused save looked like
  // nothing happened. On a new refusal it scrolls into view and takes focus (role="alert" alone is not enough).
  it("row 313: a refusal scrolls the notice into view and moves focus to it", () => {
    const scroll = jest.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<Harness error={err} />);
      fireEvent.click(screen.getByText("go"));
      const notice = screen.getByTestId("order-overpay-notice");
      expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(scroll.mock.contexts[0]).toBe(notice);
      expect(document.activeElement).toBe(notice);
      expect(notice).toHaveAttribute("tabindex", "-1");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
  it("row 313 (#3721 review): a SECOND refusal, with the notice already up, scrolls it back into view", () => {
    const scroll = jest.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<Harness error={err} />);
      fireEvent.click(screen.getByText("go"));
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.click(screen.getByText("go"));
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(screen.getByTestId("order-overpay-notice"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("captures the 409, shows fixed copy and opens the return flow", () => {
    render(<Harness error={err} />);
    fireEvent.click(screen.getByText("go"));
    const notice = screen.getByTestId("order-overpay-notice");
    expect(notice).toHaveTextContent("$20.00");
    expect(notice).not.toHaveTextContent("RAW SERVER TEXT");
    fireEvent.click(screen.getByRole("button", { name: "Record a return" }));
    expect(screen.getByTestId("return-dialog")).toHaveTextContent("o1");
  });
  it("without the inline-returns add-on the copy and the button drop Record a return", () => {
    mockHasAddon = false;
    render(<Harness error={err} />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByTestId("order-overpay-notice")).not.toHaveTextContent(/return/i);
    expect(screen.queryByRole("button", { name: "Record a return" })).toBeNull();
    mockHasAddon = true;
  });
  it("ignores other errors", () => {
    render(<Harness error={{ response: { status: 409, data: { code: "X" } } }} />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.queryByTestId("order-overpay-notice")).toBeNull();
  });
  it("Record a return and Dismiss are 44 px touch targets (jsdom has no layout, so the size class is asserted)", () => {
    render(<Harness error={err} />);
    fireEvent.click(screen.getByText("go"));
    for (const name of ["Record a return", "Dismiss"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/\bh-11\b/);
    }
  });
  it("leaving edit mode clears a shown notice, and its return dialog", () => {
    const { rerender } = render(<Harness error={err} editing />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: "Record a return" }));
    expect(screen.getByTestId("order-overpay-notice")).toBeInTheDocument();
    rerender(<Harness error={err} editing={false} />);
    expect(screen.queryByTestId("order-overpay-notice")).toBeNull();
    expect(screen.queryByTestId("return-dialog")).toBeNull();
    // and coming back to edit mode does not resurrect it
    rerender(<Harness error={err} editing />);
    expect(screen.queryByTestId("order-overpay-notice")).toBeNull();
  });
});
