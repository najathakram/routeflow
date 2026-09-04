import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MoneyInput } from "./MoneyInput";

/**
 * Money-display component 1/2. `MoneyInput` is the standard money FIELD used
 * across order/invoice builders — it formats its value to 2 decimal places
 * on blur (see the file header: "type 2.50, get 2.05" is the bug class this
 * fixes). It renders a plain decimal string ("1234.50"), not an Intl currency
 * string ("$1,234.50") — `formatMoney`/`fmt` (Intl currency) are exercised by
 * the second money-display component, SalesHistoryCard.
 */
describe("MoneyInput", () => {
  it("displays 1234.5 as 1234.50", () => {
    render(<MoneyInput value={1234.5} onChange={() => {}} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("1234.50");
  });

  it("displays 0 as 0.00", () => {
    render(<MoneyInput value={0} onChange={() => {}} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("0.00");
  });

  it("displays -12.34 as -12.34 when negative values are allowed", () => {
    render(<MoneyInput value={-12.34} onChange={() => {}} allowNegative aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("-12.34");
  });

  it("re-formats to 2 decimal places on blur without touching the value while typing", () => {
    const onChange = jest.fn();
    render(<MoneyInput value={null} onChange={onChange} aria-label="Amount" />);
    const input = screen.getByLabelText("Amount");

    fireEvent.change(input, { target: { value: "2.5" } });
    expect(input).toHaveValue("2.5"); // NOT reformatted mid-typing
    expect(onChange).toHaveBeenLastCalledWith(2.5);

    fireEvent.blur(input);
    expect(input).toHaveValue("2.50");
  });
});
