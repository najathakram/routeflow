import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CounterCustomerMatches } from "./CounterCustomerMatches";

/**
 * SA-1066 F21: the no-match `Add "<typed>" as a new customer` button hands itself to the door as the opener, so focus can
 * come back to it when the window is dismissed. A click does not focus a button in Safari, so the door cannot learn it from
 * `document.activeElement`.
 */
describe("CounterCustomerMatches: the Add button is the opener it passes (F21)", () => {
  it("calls onCreateNew with the typed name and the button itself, without the button ever being focused", () => {
    const onCreateNew = jest.fn();
    render(
      <CounterCustomerMatches
        search=" Acme Cafe "
        matches={[]}
        answered
        disabled={false}
        onPick={jest.fn()}
        onCreateNew={onCreateNew}
      />,
    );
    const btn = screen.getByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(document.activeElement).not.toBe(btn);
    fireEvent.click(btn);
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(onCreateNew).toHaveBeenCalledWith("Acme Cafe", btn);
  });
});
