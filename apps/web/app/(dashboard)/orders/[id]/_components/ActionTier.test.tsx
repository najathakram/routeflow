import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ActionTier } from "./ActionTier";

/**
 * T7 action-bar tiers. The flag-off contract is the important one: the page must render exactly as
 * before, so `ActionTier` must add NO element and NO text when `order_ui_v2` is off.
 */

let mockV2 = false;
jest.mock("@/lib/api/addons", () => ({
  useOrderUiV2: () => ({ enabled: mockV2, resolved: true }),
}));

beforeEach(() => {
  mockV2 = false;
});

describe("ActionTier — flag off (must be invisible)", () => {
  it("renders its children in place with no wrapper element", () => {
    const { container } = render(
      <div id="bar">
        <ActionTier tier="danger" caption="hidden when off">
          <button>Cancel Order</button>
        </ActionTier>
      </div>,
    );
    const bar = container.querySelector("#bar")!;
    expect(bar.children).toHaveLength(1);
    expect(bar.firstElementChild!.tagName).toBe("BUTTON"); // the button is a direct child of the bar
    expect(container.querySelector("[data-tier]")).toBeNull();
  });

  it("does not render the caption", () => {
    render(
      <ActionTier tier="danger" caption="Cancelling keeps the order">
        <button>Cancel Order</button>
      </ActionTier>,
    );
    expect(screen.queryByText("Cancelling keeps the order")).toBeNull();
  });

  it("keeps sibling order — tiers add no reordering classes when off", () => {
    const { container } = render(
      <div>
        <ActionTier tier="danger">
          <button>Delete</button>
        </ActionTier>
        <ActionTier tier="primary">
          <button>Confirm Order</button>
        </ActionTier>
      </div>,
    );
    expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Delete",
      "Confirm Order",
    ]);
    expect(container.innerHTML).not.toMatch(/order-[123]/);
  });
});

describe("ActionTier — flag on", () => {
  beforeEach(() => {
    mockV2 = true;
  });

  it("wraps each tier in its own element carrying the tier name", () => {
    render(
      <>
        <ActionTier tier="primary">
          <button>Confirm Order</button>
        </ActionTier>
        <ActionTier tier="secondary">
          <button>Unconfirm</button>
        </ActionTier>
        <ActionTier tier="danger">
          <button>Cancel Order</button>
        </ActionTier>
      </>,
    );
    for (const tier of ["primary", "secondary", "danger"]) {
      expect(screen.getByTestId(`action-tier-${tier}`)).toHaveAttribute("data-tier", tier);
    }
  });

  it("orders primary before secondary before danger, whatever the JSX order", () => {
    render(
      <>
        <ActionTier tier="danger">
          <button>Delete</button>
        </ActionTier>
        <ActionTier tier="primary">
          <button>Confirm Order</button>
        </ActionTier>
        <ActionTier tier="secondary">
          <button>Unconfirm</button>
        </ActionTier>
      </>,
    );
    expect(screen.getByTestId("action-tier-primary")).toHaveClass("order-1");
    expect(screen.getByTestId("action-tier-secondary")).toHaveClass("order-2");
    expect(screen.getByTestId("action-tier-danger")).toHaveClass("order-3");
  });

  it("the danger tier is its own ruled-off full-width row that hides itself when empty", () => {
    render(
      <ActionTier tier="danger">
        <button>Cancel Order</button>
      </ActionTier>,
    );
    const danger = screen.getByTestId("action-tier-danger");
    expect(danger).toHaveClass("w-full", "border-t", "empty:hidden");
  });

  it("an empty danger tier renders no child nodes, so `empty:hidden` can hide it", () => {
    render(<ActionTier tier="danger">{null}</ActionTier>);
    expect(screen.getByTestId("action-tier-danger").childNodes).toHaveLength(0);
  });

  it("the primary action is full width on a phone; every tier gets 44px targets under sm", () => {
    render(
      <ActionTier tier="primary">
        <button>Mark as Delivered</button>
      </ActionTier>,
    );
    const primary = screen.getByTestId("action-tier-primary");
    expect(primary).toHaveClass("max-sm:w-full");
    expect(primary.className).toContain("max-sm:[&_button]:min-h-11");
  });

  it("shows the caption under the tier", () => {
    render(
      <ActionTier tier="danger" caption="Cancelling keeps the order — you can reopen it later.">
        <button>Cancel Order</button>
      </ActionTier>,
    );
    expect(
      screen.getByText("Cancelling keeps the order — you can reopen it later."),
    ).toBeInTheDocument();
  });

  it("does not change what the buttons do — a click reaches the child's own handler", () => {
    const onClick = jest.fn();
    render(
      <ActionTier tier="primary">
        <button onClick={onClick}>Confirm Order</button>
      </ActionTier>,
    );
    screen.getByRole("button", { name: "Confirm Order" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
