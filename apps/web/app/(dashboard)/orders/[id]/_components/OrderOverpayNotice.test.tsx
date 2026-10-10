import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
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

function Harness({ error }: { error: unknown }) {
  const guard = useOrderOverpayGuard({
    id: "o1",
    customerId: "c1",
    customer: { businessName: "Acme" },
  });
  return (
    <div>
      <button onClick={() => guard.capture(error)}>go</button>
      {guard.node}
    </div>
  );
}

describe("useOrderOverpayGuard", () => {
  it("captures the 409, shows fixed copy and opens the return flow", () => {
    render(<Harness error={err} />);
    fireEvent.click(screen.getByText("go"));
    const notice = screen.getByTestId("order-overpay-notice");
    expect(notice).toHaveTextContent("$20.00");
    expect(notice).not.toHaveTextContent("RAW SERVER TEXT");
    fireEvent.click(screen.getByRole("button", { name: "Record a return" }));
    expect(screen.getByTestId("return-dialog")).toHaveTextContent("o1");
  });
  it("ignores other errors", () => {
    render(<Harness error={{ response: { status: 409, data: { code: "X" } } }} />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.queryByTestId("order-overpay-notice")).toBeNull();
  });
});
