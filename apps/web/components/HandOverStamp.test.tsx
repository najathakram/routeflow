import * as React from "react";
import { render, screen } from "@testing-library/react";
import { HandOverStamp } from "./HandOverStamp";

const ORDER = {
  status: "DELIVERED",
  fulfillPath: "PICKUP",
  registerKey: "main",
  handedOverBy: "Pat",
};

describe("HandOverStamp (row 342)", () => {
  it("shows the quiet line to staff for a handed-over order", () => {
    render(<HandOverStamp order={ORDER} role="OPERATOR" />);
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent(
      "Handed over at register main by Pat",
    );
  });
  it("omits the name when no cashier is stamped", () => {
    render(
      <HandOverStamp order={{ ...ORDER, handedOverBy: null, soldBy: null }} role="TENANT_ADMIN" />,
    );
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent("Handed over at register main");
    expect(screen.getByTestId("hand-over-stamp")).not.toHaveTextContent(" by ");
  });
  it.each(["CUSTOMER", "DRIVER", null, undefined])("renders nothing for role %s", (role) => {
    render(<HandOverStamp order={ORDER} role={role} />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
  it("renders nothing without a stamp or for an order not handed over", () => {
    const { rerender } = render(
      <HandOverStamp order={{ status: "DELIVERED", fulfillPath: "PICKUP" }} role="OPERATOR" />,
    );
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
    rerender(<HandOverStamp order={{ ...ORDER, status: "CONFIRMED" }} role="OPERATOR" />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
    rerender(<HandOverStamp order={{ ...ORDER, fulfillPath: "ROUTE" }} role="OPERATOR" />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
});
