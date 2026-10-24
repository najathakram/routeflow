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

  it("renders nothing for an order with no revisions", () => {
    const { container } = render(<OrderRevisionLog revisions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
