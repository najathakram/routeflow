import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Badge } from "@routeflow/ui/web";

/**
 * Badge used to discard JSX children (it renders its own content after spreading the rest
 * props), so `<Badge variant="success">Delivered</Badge>` — the shape ~18 call sites use, 10 of
 * them in the buyer portal — showed an empty pill. Lives in apps/web because packages/ui has no
 * test runner of its own.
 */
describe("Badge content", () => {
  it("renders JSX children", () => {
    render(<Badge variant="success">Delivered</Badge>);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("an explicit label wins over children", () => {
    render(
      <Badge variant="info" label="From label">
        From children
      </Badge>,
    );
    expect(screen.getByText("From label")).toBeInTheDocument();
    expect(screen.queryByText("From children")).toBeNull();
  });

  it("still resolves the label from `status` when there are no children", () => {
    render(<Badge status="OUT_FOR_DELIVERY" />);
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
  });

  it("renders an empty pill when given nothing", () => {
    const { container } = render(<Badge variant="neutral" />);
    expect(container.querySelector("span")?.textContent).toBe("");
  });
});
