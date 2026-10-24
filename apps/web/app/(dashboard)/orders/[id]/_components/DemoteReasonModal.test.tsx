import * as React from "react";
import { render, screen } from "@testing-library/react";
import { DemoteReasonModal } from "./DemoteReasonModal";

/**
 * Mac-mini pixel pass on #3198: "Unmark shipped" on a carrier order opened a modal titled "Return to
 * Confirmed" (a route-order word). A SHIP order walking back to CONFIRMED is unmarking shipped; every
 * other order keeps today's words.
 */
const base = { open: true, onClose: jest.fn(), onConfirm: jest.fn(), loading: false };

describe("DemoteReasonModal wording", () => {
  it("a SHIP order demoted to CONFIRMED says Unmark shipped", () => {
    render(<DemoteReasonModal {...base} targetStatus="CONFIRMED" fulfillPath="SHIP" />);
    expect(screen.getByRole("heading", { name: "Unmark shipped" })).toBeInTheDocument();
    expect(screen.getByText("Why is this order being unmarked as shipped?")).toBeInTheDocument();
    expect(screen.queryByText(/Return to Confirmed/)).not.toBeInTheDocument();
  });

  it.each([["ROUTE"], [undefined], [null]])(
    "%s order demoted to CONFIRMED keeps Return to Confirmed",
    (path) => {
      render(<DemoteReasonModal {...base} targetStatus="CONFIRMED" fulfillPath={path} />);
      expect(screen.getByRole("heading", { name: "Return to Confirmed" })).toBeInTheDocument();
      expect(
        screen.getByText("Why is this order being returned to confirmed?"),
      ).toBeInTheDocument();
    },
  );

  it("PENDING is unchanged for a SHIP order", () => {
    render(<DemoteReasonModal {...base} targetStatus="PENDING" fulfillPath="SHIP" />);
    expect(screen.getByRole("heading", { name: "Return to Pending" })).toBeInTheDocument();
  });
});
