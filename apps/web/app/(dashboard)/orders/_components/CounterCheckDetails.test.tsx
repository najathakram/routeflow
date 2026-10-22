import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterCheckDetails } from "./CounterCheckDetails";

/**
 * Interim till guard: a check dated after the tenant's today is never tendered. The component is all props: the
 * parent owns the values, the tenant's day and what "on account" does.
 */
const SENTENCE = "Post-dated check: put this sale on account and record the check when it clears.";

function setup(over: Partial<React.ComponentProps<typeof CounterCheckDetails>> = {}) {
  const props = {
    reference: "",
    onReferenceChange: jest.fn(),
    checkDate: "2026-10-22",
    onCheckDateChange: jest.fn(),
    today: "2026-10-22",
    walkIn: false,
    disabled: false,
    onPutOnAccount: jest.fn(),
    ...over,
  };
  render(<CounterCheckDetails {...props} />);
  return props;
}

describe("CounterCheckDetails", () => {
  it("keeps the check number input the inline one had (same label, value, change)", () => {
    const p = setup({ reference: "1042" });
    const input = screen.getByLabelText("Check number") as HTMLInputElement;
    expect(input.value).toBe("1042");
    fireEvent.change(input, { target: { value: "1043" } });
    expect(p.onReferenceChange).toHaveBeenCalledWith("1043");
  });

  it("shows the check date, as given", () => {
    setup({ checkDate: "2026-10-20" });
    expect((screen.getByLabelText("Check date") as HTMLInputElement).value).toBe("2026-10-20");
  });

  it("reports an edited date", () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: "2026-10-30" } });
    expect(p.onCheckDateChange).toHaveBeenCalledWith("2026-10-30");
  });

  it.each([
    ["today", "2026-10-22"],
    ["yesterday", "2026-10-21"],
    ["cleared", ""],
  ])("no message and no button when the date is %s", (_n, checkDate) => {
    setup({ checkDate });
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Put this sale on account" })).toBeNull();
  });

  it("a future date shows the sentence and ONE button that calls onPutOnAccount", () => {
    const p = setup({ checkDate: "2026-10-23" });
    expect(screen.getByRole("alert")).toHaveTextContent(SENTENCE);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Put this sale on account");
    expect(buttons[0]).toBeEnabled();
    fireEvent.click(buttons[0]);
    expect(p.onPutOnAccount).toHaveBeenCalledTimes(1);
  });

  it("a walk-in cannot go on account: the button is disabled, says why, and never calls back", () => {
    const p = setup({ checkDate: "2026-10-23", walkIn: true });
    expect(screen.getByRole("alert")).toHaveTextContent(SENTENCE);
    const button = screen.getByRole("button", { name: "Put this sale on account" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/pick a customer/i)).toBeInTheDocument();
    fireEvent.click(button);
    expect(p.onPutOnAccount).not.toHaveBeenCalled();
  });

  it("a locked sale (POST in flight) disables the inputs and the button", () => {
    setup({ checkDate: "2026-10-23", disabled: true });
    expect(screen.getByLabelText("Check number")).toBeDisabled();
    expect(screen.getByLabelText("Check date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Put this sale on account" })).toBeDisabled();
  });

  it("the tenant's day decides, not the date alone: the same date flips with `today`", () => {
    const { rerender } = render(
      <CounterCheckDetails
        reference=""
        onReferenceChange={jest.fn()}
        checkDate="2026-10-23"
        onCheckDateChange={jest.fn()}
        today="2026-10-23"
        walkIn={false}
        disabled={false}
        onPutOnAccount={jest.fn()}
      />,
    );
    expect(screen.queryByText(SENTENCE)).toBeNull();
    rerender(
      <CounterCheckDetails
        reference=""
        onReferenceChange={jest.fn()}
        checkDate="2026-10-23"
        onCheckDateChange={jest.fn()}
        today="2026-10-22"
        walkIn={false}
        disabled={false}
        onPutOnAccount={jest.fn()}
      />,
    );
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
  });
});
