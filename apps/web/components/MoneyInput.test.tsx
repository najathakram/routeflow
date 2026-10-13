import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  describe("a value that arrives while the field is focused and untouched (apple-ux 2026-10-13: 272.00)", () => {
    // A unit pick resolves its price asynchronously; focus can reach the field first. The field must show the
    // new value SELECTED, so the next digit replaces it, never appends to or gets dropped behind it.
    function Harness({ initial }: { initial: number }) {
      const [v, setV] = React.useState<number | null>(initial);
      return (
        <>
          <MoneyInput value={v} onChange={setV} aria-label="Unit price" />
          <button type="button" onClick={() => setV(72)}>
            late price
          </button>
        </>
      );
    }

    it("shows the late value, fully selected, and a typed 2 is 2 (not 272.00, not 72.00)", async () => {
      const user = userEvent.setup();
      render(<Harness initial={6.99} />);
      const input = screen.getByLabelText("Unit price") as HTMLInputElement;
      input.focus();
      expect(input).toHaveFocus();
      // the late price lands without moving focus (a programmatic state change, as the async resolution does)
      fireEvent.click(screen.getByRole("button", { name: "late price" }));
      input.focus();
      expect(input).toHaveValue("72.00");
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
      await user.keyboard("2");
      expect(input).toHaveValue("2");
    });

    it("never overwrites what the operator has already typed since focusing", async () => {
      const user = userEvent.setup();
      render(<Harness initial={6.99} />);
      const input = screen.getByLabelText("Unit price") as HTMLInputElement;
      await user.click(input);
      await user.keyboard("5");
      expect(input).toHaveValue("5");
      fireEvent.click(screen.getByRole("button", { name: "late price" }));
      input.focus();
      expect(input).toHaveValue("5");
    });
  });
});
