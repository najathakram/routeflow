import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArrivedStopSheet } from "./ArrivedStopSheet";

/**
 * B966: "New order at door" (→ /orders?action=new) and "Collect payment" (→ /finance/payments)
 * both land on routes a pure DRIVER is bounced off (RouteGuard DRIVER_ALLOWED = /dashboard,
 * /routes, /settings): dead ends. Drivers place and collect in the native app. Both tiles are
 * hidden for a DRIVER; staff keep all three. "Adjust order" (under /orders/:id, reached from a
 * route the driver can open) is untouched.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let mockRole: string | undefined = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: mockRole ? { role: mockRole } : null }),
}));

function open() {
  render(
    <ArrivedStopSheet
      open
      onClose={jest.fn()}
      customerName="Acme Foods"
      orders={[{ id: "o1", orderNumber: "1001" }]}
    />,
  );
}

describe("ArrivedStopSheet role gating (B966)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = "OPERATOR";
  });

  it("a DRIVER sees only 'Adjust order'", () => {
    mockRole = "DRIVER";
    open();
    expect(screen.getByText("Adjust order")).toBeInTheDocument();
    expect(screen.queryByText("New order at door")).not.toBeInTheDocument();
    expect(screen.queryByText("Collect payment")).not.toBeInTheDocument();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s sees all three tiles", (role) => {
    mockRole = role;
    open();
    expect(screen.getByText("Adjust order")).toBeInTheDocument();
    expect(screen.getByText("New order at door")).toBeInTheDocument();
    expect(screen.getByText("Collect payment")).toBeInTheDocument();
  });

  it("staff navigation is unchanged", () => {
    open();
    fireEvent.click(screen.getByText("New order at door"));
    expect(push).toHaveBeenCalledWith("/orders?action=new");
    fireEvent.click(screen.getByText("Collect payment"));
    expect(push).toHaveBeenCalledWith("/finance/payments");
  });

  it("no signed-in user (not yet loaded) shows neither staff-only tile", () => {
    mockRole = undefined;
    open();
    expect(screen.queryByText("New order at door")).not.toBeInTheDocument();
    expect(screen.queryByText("Collect payment")).not.toBeInTheDocument();
  });
});
