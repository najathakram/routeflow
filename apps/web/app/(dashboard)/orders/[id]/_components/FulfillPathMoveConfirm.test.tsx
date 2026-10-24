import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FulfillPathMoveConfirm } from "./FulfillPathMoveConfirm";

// The real dialog keeps its content mounted while it animates closed, so the description must not change
// back to the pickup-only copy the moment the page clears `path` on confirm (M8, the copy flashed).
jest.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ description }: { description?: string }) => (
    <p data-testid="description">{description}</p>
  ),
}));

const noop = () => undefined;
const desc = () => screen.getByTestId("description").textContent ?? "";

describe("FulfillPathMoveConfirm copy", () => {
  it("SHIP names the carrier and tracking number", () => {
    render(<FulfillPathMoveConfirm open path="SHIP" onClose={noop} onConfirm={noop} />);
    expect(desc()).toMatch(/carrier and tracking number/);
  });

  it("keeps the SHIP copy while it closes (path cleared, open false)", () => {
    const { rerender } = render(
      <FulfillPathMoveConfirm open path="SHIP" onClose={noop} onConfirm={noop} loading />,
    );
    rerender(<FulfillPathMoveConfirm open={false} path={null} onClose={noop} onConfirm={noop} />);
    expect(desc()).toMatch(/carrier and tracking number/);
  });

  it("a later open for ROUTE shows the plain copy, not the stale SHIP one", () => {
    const { rerender } = render(
      <FulfillPathMoveConfirm open path="SHIP" onClose={noop} onConfirm={noop} />,
    );
    rerender(<FulfillPathMoveConfirm open={false} path={null} onClose={noop} onConfirm={noop} />);
    rerender(<FulfillPathMoveConfirm open path="ROUTE" onClose={noop} onConfirm={noop} />);
    expect(desc()).toBe("It will no longer be a pickup order.");
  });
});
