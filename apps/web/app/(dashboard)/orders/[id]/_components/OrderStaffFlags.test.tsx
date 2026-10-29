import * as React from "react";
import { render, screen } from "@testing-library/react";
import { OrderStaffFlags } from "./OrderStaffFlags";

/**
 * SA-1026 A: the staff order header's flags in one place: "Invoices need review" (B1116) and "To collect". The server sends
 * both fields to staff only; with neither, nothing renders.
 */
describe("OrderStaffFlags", () => {
  it("a To collect order shows the chip", () => {
    render(<OrderStaffFlags order={{ toCollect: "TO_COLLECT" }} />);
    expect(screen.getByTestId("to-collect-chip")).toHaveTextContent("To collect");
  });

  it("keeps the invoices-need-review badge beside it", () => {
    render(
      <OrderStaffFlags
        order={{ toCollect: "TO_COLLECT", invoicesNeedReview: { flagged: true } }}
      />,
    );
    expect(screen.getByTestId("order-invoices-need-review-badge")).toBeInTheDocument();
    expect(screen.getByTestId("to-collect-chip")).toBeInTheDocument();
  });

  it("NONE, absent and an unflagged order show nothing", () => {
    const { container, rerender } = render(<OrderStaffFlags order={{ toCollect: "NONE" }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OrderStaffFlags order={{}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OrderStaffFlags order={{ invoicesNeedReview: { flagged: false } }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
