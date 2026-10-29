import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterVoidSaleDialog } from "./CounterVoidSaleDialog";

/** W-890: the void dialog's close button is a 44 px target; jsdom has no layout, so the classes are asserted. */
jest.mock("@/lib/api-client", () => ({ apiClient: { post: jest.fn() } }));

describe("CounterVoidSaleDialog: phone tap targets (W-890)", () => {
  it("the close button is a 44 px box below lg and keeps its desktop size", () => {
    renderWithProviders(
      <CounterVoidSaleDialog
        open
        orderId="o1"
        orderNumber="ORD-1"
        total={22.5}
        onClose={jest.fn()}
        onVoided={jest.fn()}
      />,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("max-lg:min-h-11");
    expect(close).toHaveClass("max-lg:min-w-11");
    expect(close).not.toHaveClass("min-h-[44px]"); // desktop density is unchanged
  });
});
