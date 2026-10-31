import * as React from "react";
import { render } from "@testing-library/react";
import { ActionTier } from "./ActionTier";

/**
 * SA-1066 P31: on a phone the secondary tier is `shrink-0`, so a long helper line beside a button (Reopen's) pushed the row
 * wider than the screen. It is capped at its container's width (`max-w-full`) so the line wraps inside, and an ordinary
 * button keeps its natural width (`shrink-0`). jsdom has no layout: the wrap itself is the browser row.
 */
jest.mock("@/lib/hooks/useBelowBreakpoint", () => ({ useBelowBreakpoint: () => true }));
jest.mock("@/lib/api/addons", () => ({ useOrderUiV2: () => ({ enabled: false, resolved: true }) }));

describe("ActionTier on a phone: the secondary tier stays inside the screen (P31)", () => {
  it("is capped at its container width and still never shrinks an ordinary button", () => {
    const { container } = render(
      <ActionTier tier="secondary">
        <button>Reopen</button>
        <p>This order was invoiced; reopening it voids the invoice and puts the lines back.</p>
      </ActionTier>,
    );
    const tier = container.querySelector('[data-tier="secondary"]') as HTMLElement;
    expect(tier).toHaveClass("order-2", "shrink-0", "max-w-full");
  });
});
