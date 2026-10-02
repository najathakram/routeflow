import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArrivedStopSheet } from "./ArrivedStopSheet";

/**
 * B966: "New order at door" (→ /orders?action=new) and "Collect payment" (→ /finance/payments)
 * both land on routes a pure DRIVER is bounced off (RouteGuard DRIVER_ALLOWED = /dashboard,
 * /routes, /settings): dead ends. Drivers place and collect in the native app. Both tiles are
 * hidden for a DRIVER, and so is "Adjust order" (it goes to /orders/:id, bounced the same way);
 * staff keep all three. A DRIVER's sheet therefore has NO tiles: it shows a short pointer to the
 * driver app instead of an empty action row, and the title and close still work.
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

  it("a DRIVER sees NO tiles, a pointer to the driver app, and no empty action row", () => {
    mockRole = "DRIVER";
    const onClose = jest.fn();
    render(
      <ArrivedStopSheet
        open
        onClose={onClose}
        customerName="Acme Foods"
        orders={[{ id: "o1", orderNumber: "1001" }]}
      />,
    );
    expect(screen.queryByText("Adjust order")).not.toBeInTheDocument();
    expect(screen.queryByText("New order at door")).not.toBeInTheDocument();
    expect(screen.queryByText("Collect payment")).not.toBeInTheDocument();
    expect(screen.queryByText("At-the-door actions")).not.toBeInTheDocument();
    expect(screen.getByText(/Use the RouteFlow driver app/i)).toBeInTheDocument();
    expect(document.querySelector(".space-y-2\\.5")).toBeNull(); // no empty action container
    // The sheet itself still works: the title shows and Close dismisses it.
    expect(screen.getByText("Acme Foods")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
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

  it("no signed-in user (not yet loaded) shows no tile at all", () => {
    mockRole = undefined;
    open();
    expect(screen.queryByText("Adjust order")).not.toBeInTheDocument();
    expect(screen.queryByText("New order at door")).not.toBeInTheDocument();
    expect(screen.queryByText("Collect payment")).not.toBeInTheDocument();
  });
});
