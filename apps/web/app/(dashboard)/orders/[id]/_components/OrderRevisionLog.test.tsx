import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { OrderRevisionLog } from "./OrderRevisionLog";
import type { OrderRevision } from "@/lib/api/orders";

/**
 * Row 330d: the order's append-only edit history is one tap away. The "Edited N×" chip used to carry the log
 * only in a `title` tooltip, which a touch screen never shows; it is now a button that opens the list inline,
 * and `#order-revisions` (the link target from an invoice's "Revised" badge) opens it on arrival.
 */
const rev = (n: number, over: Partial<OrderRevision> = {}): OrderRevision =>
  ({
    id: `rev-${n}`,
    revisionNumber: n,
    editedByName: n === 1 ? "Pat Cashier" : null,
    editedByRole: n === 2 ? "OPERATOR" : null,
    source: "EDIT",
    reason: n === 2 ? "Customer added a case" : null,
    createdAt: `2026-10-0${n}T15:00:00Z`,
    snapshot: { subtotal: 100 * n, tax: 0, total: 100 * n, lineItems: [] },
    ...over,
  }) as OrderRevision;

afterEach(() => {
  window.location.hash = "";
});

describe("OrderRevisionLog", () => {
  it("renders the count chip as a collapsed button, with the log hidden", () => {
    render(<OrderRevisionLog revisions={[rev(1), rev(2)]} />);
    const chip = screen.getByRole("button", { name: /Edited 2×/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("order-revision-log")).toBeNull();
  });

  it("one tap opens the log, newest first, with who, what the total became and the reason", () => {
    render(<OrderRevisionLog revisions={[rev(1), rev(2)]} />);
    const chip = screen.getByRole("button", { name: /Edited 2×/ });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const log = screen.getByTestId("order-revision-log");
    const rows = within(log).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("v2");
    expect(rows[0]).toHaveTextContent("OPERATOR");
    expect(rows[0]).toHaveTextContent("$200.00");
    expect(rows[0]).toHaveTextContent("Customer added a case");
    expect(rows[1]).toHaveTextContent("v1");
    expect(rows[1]).toHaveTextContent("Pat Cashier");
    expect(chip).toHaveAttribute("aria-controls", log.id);
    fireEvent.click(chip);
    expect(screen.queryByTestId("order-revision-log")).toBeNull();
  });

  it("names a revision with no actor as system", () => {
    render(<OrderRevisionLog revisions={[rev(3, { editedByName: null, editedByRole: null })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited 1×/ }));
    expect(screen.getByTestId("order-revision-log")).toHaveTextContent("system");
  });

  it("opens by itself when the page is reached at #order-revisions (the invoice's Revised badge link)", () => {
    window.location.hash = "#order-revisions";
    render(<OrderRevisionLog revisions={[rev(1)]} />);
    expect(screen.getByTestId("order-revision-log")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edited 1×/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  // apple-ux r5 N08: the page's action row (`data-testid=order-actions`) pushes every non-tier child to the end at
  // phone width with `[&>:not([data-tier])]:order-5`. This component's root is `display: contents`, so that rule
  // lands on a box that does not exist and the chip (order 0) used to take the FIRST slot, wrapping Edit Items + ⋯.
  // The chip button (and the opened log) must carry their own order, after every tier (order-1..4).
  it("orders its chip after the action tiers at phone width (the root is display: contents)", () => {
    const { container } = render(<OrderRevisionLog revisions={[rev(1)]} />);
    expect(container.querySelector("#order-revisions")).toHaveClass("contents");
    expect(screen.getByRole("button", { name: /Edited 1×/ })).toHaveClass("max-sm:order-5");
  });

  it("keeps the opened log after its chip, on its own full-width line", () => {
    render(<OrderRevisionLog revisions={[rev(1)]} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited 1×/ }));
    const log = screen.getByTestId("order-revision-log");
    expect(log).toHaveClass("max-sm:order-6");
    expect(log).toHaveClass("basis-full");
  });

  it("renders nothing for an order with no revisions", () => {
    const { container } = render(<OrderRevisionLog revisions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
