import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaymentStatusCheck } from "./PaymentStatusCheck";

/** SA-824: the block every record-payment dialog shows; fixed copy, one action. */
const base = { unknown: false, checking: false, message: null, check: jest.fn() };

describe("PaymentStatusCheck", () => {
  it("renders nothing when nothing is unknown and nothing was answered", () => {
    const { container } = render(<PaymentStatusCheck status={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("unknown: the hint and the Check payment status action, which runs the check", () => {
    const check = jest.fn();
    render(<PaymentStatusCheck status={{ ...base, unknown: true, check }} />);
    expect(screen.getByText(/It may already be recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    expect(check).toHaveBeenCalled();
  });

  it("answered and no longer unknown: only the line, no action", () => {
    render(
      <PaymentStatusCheck
        status={{ ...base, message: "Nothing was recorded. You can try again." }}
      />,
    );
    expect(screen.getByText("Nothing was recorded. You can try again.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
