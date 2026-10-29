import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterVoidSaleDialog } from "./CounterVoidSaleDialog";

/** F14: the reason is marked required up front (the house "(required)" label), not only after a failed submit. */
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));

describe("void dialog: the reason is required up front", () => {
  it("the field is labelled (required) and aria-required before anything is typed", () => {
    renderWithProviders(
      <CounterVoidSaleDialog
        open
        orderId="o1"
        orderNumber="ORD-00001"
        total={25}
        onClose={jest.fn()}
        onVoided={jest.fn()}
      />,
    );
    const field = screen.getByLabelText("Reason for voiding (required)");
    expect(field).toHaveAttribute("aria-required", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
