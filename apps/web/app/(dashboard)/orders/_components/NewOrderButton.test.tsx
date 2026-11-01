import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { NewOrderButton } from "./NewOrderButton";

/**
 * W62 (SA-940 A-3, SA-1073): a menu item never opens a dialog in its own select. Radix runs the select in `flushSync`, so a
 * dialog mounted there sits under the still-open menu and freezes the page when it closes. jsdom can't show the freeze,
 * so this pins the order; the real path is the Playwright row in `e2e/68-create-order-customer-keyboard.spec.ts`.
 */
describe("NewOrderButton: a pick runs after the menu closes", () => {
  const open = async (onRegularOrder: () => void, onCounterSale: () => void) => {
    renderWithProviders(
      <NewOrderButton
        entry={{ kind: "menu", first: "order" }}
        capability={{ methods: ["ROUTE"], counter: "optional" } as never}
        onRegularOrder={onRegularOrder}
        onCounterSale={onCounterSale}
      />,
    );
    await userEvent.setup().click(screen.getByTestId("new-order-open"));
    return screen.findAllByRole("menuitem");
  };

  it("W62: Regular order runs after the timer, not in the select", async () => {
    const regular = jest.fn();
    const [item] = await open(regular, jest.fn());
    fireEvent.click(item);
    expect(regular).not.toHaveBeenCalled();
    await waitFor(() => expect(regular).toHaveBeenCalledTimes(1));
  });

  it("W62: Counter sale runs after the timer too", async () => {
    const counter = jest.fn();
    const items = await open(jest.fn(), counter);
    fireEvent.click(items[1]);
    expect(counter).not.toHaveBeenCalled();
    await waitFor(() => expect(counter).toHaveBeenCalledTimes(1));
  });
});
