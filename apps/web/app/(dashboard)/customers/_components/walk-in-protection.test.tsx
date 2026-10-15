import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountStatusControls, WALK_IN_PROTECTED_COPY } from "./walk-in-protection";

/**
 * SA-672a (e): the customer detail's Account Status card. The tenant's system walk-in customer (counter
 * sales) gets no status buttons and no Remove: only its current status and why. An ordinary customer keeps
 * the three status buttons and, only while SUSPENDED, Remove.
 */
const base = {
  currentStatus: "ACTIVE" as const,
  pending: false,
  onChange: jest.fn(),
  onRemove: jest.fn(),
};

describe("AccountStatusControls", () => {
  beforeEach(() => jest.clearAllMocks());

  it("walk-in: no status buttons, no Remove, and the reason is shown", () => {
    render(<AccountStatusControls {...base} isWalkIn currentStatus="SUSPENDED" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(WALK_IN_PROTECTED_COPY)).toBeInTheDocument();
  });

  it("ordinary customer: three status buttons that call onChange", () => {
    render(<AccountStatusControls {...base} isWalkIn={false} />);
    fireEvent.click(screen.getByRole("button", { name: /inactive/i }));
    expect(base.onChange).toHaveBeenCalledWith("INACTIVE");
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText(WALK_IN_PROTECTED_COPY)).toBeNull();
  });

  it("ordinary customer: Remove only while SUSPENDED", () => {
    const { rerender } = render(<AccountStatusControls {...base} isWalkIn={null} />);
    expect(screen.queryByRole("button", { name: /remove customer/i })).toBeNull();
    rerender(<AccountStatusControls {...base} isWalkIn={null} currentStatus="SUSPENDED" />);
    fireEvent.click(screen.getByRole("button", { name: /remove customer/i }));
    expect(base.onRemove).toHaveBeenCalled();
  });
});
