import * as React from "react";
import { render } from "@testing-library/react";
import { ActionTier } from "./ActionTier";

/**
 * T7 action-bar tiers. The flag-off contract is the important one: the page must render exactly as
 * before, so `ActionTier` must add NO element and NO reordering class when `order_ui_v2` is off.
 * Which button sits in which tier on the real page is pinned by `ActionTier.wiring.test.ts`.
 */

let mockV2 = false;
jest.mock("@/lib/api/addons", () => ({
  useOrderUiV2: () => ({ enabled: mockV2, resolved: true }),
}));

beforeEach(() => {
  mockV2 = false;
});

const tierEl = (c: HTMLElement, tier: string) =>
  c.querySelector(`[data-tier="${tier}"]`) as HTMLElement;

describe("ActionTier — flag off (must be invisible)", () => {
  it("renders its children in place with no wrapper element", () => {
    const { container } = render(
      <div id="bar">
        <ActionTier tier="danger">
          <button>Cancel Order</button>
        </ActionTier>
      </div>,
    );
    const bar = container.querySelector("#bar")!;
    expect(bar.children).toHaveLength(1);
    expect(bar.firstElementChild!.tagName).toBe("BUTTON"); // a direct child of the bar
    expect(container.querySelector("[data-tier]")).toBeNull();
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
    const { container } = render(
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
      expect(tierEl(container, tier)).not.toBeNull();
    }
  });

  it("several secondary tiers can share a bar (Edit Items + a status's own) without an id clash", () => {
    const { container } = render(
      <>
        <ActionTier tier="secondary">
          <button>Edit Items</button>
        </ActionTier>
        <ActionTier tier="secondary">
          <button>Unconfirm</button>
        </ActionTier>
      </>,
    );
    expect(container.querySelectorAll('[data-tier="secondary"]')).toHaveLength(2);
    expect(container.querySelector("[id]")).toBeNull();
  });

  it("orders primary before secondary before danger, whatever the JSX order", () => {
    const { container } = render(
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
    expect(tierEl(container, "primary")).toHaveClass("order-1");
    expect(tierEl(container, "secondary")).toHaveClass("order-2");
    expect(tierEl(container, "danger")).toHaveClass("order-3");
  });

  it("the danger tier is its own ruled-off full-width row that hides itself when empty", () => {
    const { container } = render(
      <ActionTier tier="danger">
        <button>Cancel Order</button>
      </ActionTier>,
    );
    expect(tierEl(container, "danger")).toHaveClass("w-full", "border-t", "empty:hidden");
  });

  it("an empty danger tier renders no child nodes, so `empty:hidden` can hide it", () => {
    const { container } = render(<ActionTier tier="danger">{null}</ActionTier>);
    expect(tierEl(container, "danger").childNodes).toHaveLength(0);
  });

  it("the primary CTA fills the row on a phone — including a button inside a wrapper", () => {
    const { container } = render(
      <ActionTier tier="primary">
        <div className="flex flex-col items-start gap-1">
          <button>Out for Delivery</button>
        </div>
      </ActionTier>,
    );
    const primary = tierEl(container, "primary");
    expect(primary).toHaveClass("max-sm:w-full");
    expect(primary.className).toContain("max-sm:[&>*]:flex-1"); // stretches the wrapper...
    expect(primary.className).toContain("max-sm:[&_button]:w-full"); // ...and the button inside it
  });

  it("every tier gets 44px touch targets under sm", () => {
    const { container } = render(
      <>
        <ActionTier tier="primary">
          <button>A</button>
        </ActionTier>
        <ActionTier tier="secondary">
          <button>B</button>
        </ActionTier>
        <ActionTier tier="danger">
          <button>C</button>
        </ActionTier>
      </>,
    );
    for (const tier of ["primary", "secondary", "danger"]) {
      expect(tierEl(container, tier).className).toContain("max-sm:[&_button]:min-h-11");
    }
  });

  it("adds no caption or text of its own — nothing reassuring above the cancel-impact dialog", () => {
    const { container } = render(
      <ActionTier tier="danger">
        <button>Cancel Order</button>
      </ActionTier>,
    );
    expect(tierEl(container, "danger").textContent).toBe("Cancel Order");
  });

  it("does not change what the buttons do — a click reaches the child's own handler", () => {
    const onClick = jest.fn();
    const { getByRole } = render(
      <ActionTier tier="primary">
        <button onClick={onClick}>Confirm Order</button>
      </ActionTier>,
    );
    getByRole("button", { name: "Confirm Order" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
