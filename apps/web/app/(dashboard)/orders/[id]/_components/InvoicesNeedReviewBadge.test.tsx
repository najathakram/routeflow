import * as React from "react";
import { render, screen } from "@testing-library/react";
import { InvoicesNeedReviewBadge } from "./InvoicesNeedReviewBadge";

/**
 * B1116: the office badge on the staff order header. Renders only when the server says the order's
 * invoices need review; the tooltip carries the reason and, when a driver's stop completion flagged
 * it, who and when. Nothing renders otherwise.
 */
const REASON = "This order's invoices don't match its lines.";

describe("InvoicesNeedReviewBadge", () => {
  it("renders the warning badge with the reason as its tooltip when flagged", () => {
    render(<InvoicesNeedReviewBadge review={{ flagged: true, reason: REASON }} />);
    const badge = screen.getByTestId("order-invoices-need-review-badge");
    expect(badge).toHaveTextContent("Invoices need review");
    expect(badge).toHaveAttribute("title", REASON);
    // the design-system warning tone, same Badge as the status pill beside it
    expect(badge.className).toContain("bg-warning-bg");
  });

  it("adds who flagged it at a stop and when to the tooltip", () => {
    render(
      <InvoicesNeedReviewBadge
        review={{
          flagged: true,
          reason: REASON,
          flaggedAtStop: { by: "Dana Driver", at: "2026-10-05T15:30:00.000Z" },
        }}
      />,
    );
    const title = screen.getByTestId("order-invoices-need-review-badge").getAttribute("title");
    expect(title).toContain(REASON);
    expect(title).toContain("Flagged at stop completion by Dana Driver");
  });

  it("still renders (reason-less tooltip falls back to a fixed line) when only flagged is sent", () => {
    render(<InvoicesNeedReviewBadge review={{ flagged: true }} />);
    expect(screen.getByTestId("order-invoices-need-review-badge")).toHaveAttribute(
      "title",
      expect.stringMatching(/review/i),
    );
  });

  it.each([
    ["flagged is false", { flagged: false }],
    ["the field is absent (buyer, driver or an older API)", undefined],
    ["the field is null", null],
  ])("renders nothing when %s", (_name, review) => {
    const { container } = render(<InvoicesNeedReviewBadge review={review as never} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("order-invoices-need-review-badge")).toBeNull();
    expect(screen.queryByText(/Invoices need review/i)).toBeNull();
  });
});
