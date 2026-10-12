import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CounterLinePriceEdit, type CounterLinePriceEditProps } from "./CounterLinePriceEdit";
import { lineTotalAt, type PriceEditLine } from "@/lib/counter-price-edit";

/**
 * POS-5: the counter line's price control. It renders ONLY with the `canEditPrices` flag, resolves percent /
 * amount / set to one net unit price through the shared helper, and owns no sale state: Apply hands the result
 * to `onApply`, Cancel and Escape change nothing.
 */
const plain: PriceEditLine = { tierPrice: 10, listPrice: 10, tier: 1, qty: 2 };
const boxed: PriceEditLine = {
  tierPrice: 24,
  listPrice: 24,
  tier: 1,
  qty: 27,
  boxes: 2,
  pieces: 3,
  unitsPerBox: 12,
};

function mount(over: Partial<CounterLinePriceEditProps> = {}) {
  const onApply = jest.fn();
  const onClosed = jest.fn();
  const onReset = jest.fn();
  const utils = render(
    <div>
      <input data-testid="scan" />
      <CounterLinePriceEdit
        canEditPrices
        name="Cola"
        line={plain}
        onApply={onApply}
        onClosed={onClosed}
        onReset={onReset}
        {...over}
      />
    </div>,
  );
  return { ...utils, onApply, onClosed, onReset };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Edit price for Cola" }));
const field = (name: RegExp | string) => screen.getByRole("textbox", { name });
const mode = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

describe("CounterLinePriceEdit: hidden without the flag", () => {
  it("canEditPrices=false renders NOTHING (no button, no label, no tab stop, no text)", () => {
    const { container } = mount({ canEditPrices: false, edited: true });
    expect(screen.queryByRole("button", { name: /Edit price/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset price/ })).toBeNull();
    expect(container.innerHTML).not.toMatch(/Edit price|Reset price/);
    expect(container.querySelectorAll("button, [tabindex]")).toHaveLength(0);
  });

  it("canEditPrices=true shows the button with its accessible name", () => {
    mount();
    expect(screen.getByRole("button", { name: "Edit price for Cola" })).toBeEnabled();
  });

  it("locked disables the control (an unknown-outcome sale)", () => {
    mount({ locked: true, edited: true });
    expect(screen.getByRole("button", { name: "Edit price for Cola" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset price" })).toBeDisabled();
  });

  it("Reset price shows only on an edited line and calls onReset", () => {
    const a = mount();
    expect(screen.queryByRole("button", { name: "Reset price" })).toBeNull();
    a.unmount();
    const b = mount({ edited: true });
    fireEvent.click(screen.getByRole("button", { name: "Reset price" }));
    expect(b.onReset).toHaveBeenCalledTimes(1);
  });
});

describe("CounterLinePriceEdit: the dialog", () => {
  it("opens titled for the product with focus in the number field; Set price is the default mode", async () => {
    mount();
    open();
    expect(await screen.findByRole("dialog", { name: "Change price for Cola" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Set price" })).toBeChecked();
    await waitFor(() => expect(field("Price per item")).toHaveFocus());
  });

  it("percent off 10 on a 10.00 item: preview, then Apply hands back net 9", async () => {
    const { onApply } = mount();
    open();
    mode("Percent off");
    fireEvent.change(field("Percent off"), { target: { value: "10" } });
    expect(screen.getByText("New price $9.00 per item. Line total $18.00.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      mode: "percent",
      value: 10,
      unitPrice: 9,
      override: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Enter in the number field applies (a set price, with a trimmed reason)", () => {
    const { onApply } = mount();
    open();
    fireEvent.change(field("Price per item"), { target: { value: "7.25" } });
    fireEvent.change(field("Reason (optional)"), { target: { value: "  damaged box " } });
    fireEvent.submit(field("Price per item"));
    expect(onApply).toHaveBeenCalledWith({
      mode: "set",
      value: 7.25,
      unitPrice: 7.25,
      override: true,
      reason: "damaged box",
    });
  });

  it("amount off 2.50 gives 7.50; a result at the tier price reports override:false", () => {
    const { onApply } = mount();
    open();
    mode("Amount off");
    fireEvent.change(field("Amount off per item"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ unitPrice: 7.5 }));
    open();
    fireEvent.change(field("Price per item"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitPrice: 10, override: false }),
    );
  });

  it("a boxed line reads per box and its preview equals the cart's computeLineSubtotal total", () => {
    mount({ line: boxed });
    open();
    mode("Percent off");
    fireEvent.change(field("Percent off"), { target: { value: "10" } });
    expect(screen.getByRole("radio", { name: "Amount off" })).toBeTruthy();
    expect(lineTotalAt(boxed, 21.6)).toBe(48.6);
    expect(screen.getByText("New price $21.60 per box. Line total $48.60.")).toBeTruthy();
    mode("Amount off");
    expect(field("Amount off per box")).toBeTruthy();
    mode("Set price");
    expect(field("Price per box")).toBeTruthy();
  });

  it.each([
    ["set", "Price per item", "abc", "Enter a price, like 12.50."],
    ["set", "Price per item", "", "Enter a price, like 12.50."],
    ["set", "Price per item", "-1", "Enter 0 or more."],
    ["percent", "Percent off", "100.01", "Enter a percentage from 0 to 100."],
    ["percent", "Percent off", "abc", "Enter a percentage, like 10 or 12.5."],
    ["percent", "Percent off", "", "Enter a percentage, like 10 or 12.5."],
    ["percent", "Percent off", "10.555", "Use at most two decimals, like 12.5."],
    ["amount", "Amount off per item", "abc", "Enter an amount off, like 1.50."],
    ["amount", "Amount off per item", "11", "That's more than the price. Enter $10.00 or less."],
  ] as const)(
    "%s refusal %j shows its exact copy in role=alert and the dialog stays open",
    (m, label, v, copy) => {
      const { onApply } = mount();
      open();
      if (m === "percent") mode("Percent off");
      if (m === "amount") mode("Amount off");
      fireEvent.change(field(label), { target: { value: v } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      expect(screen.getByRole("alert")).toHaveTextContent(copy);
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(field(label)).toHaveFocus();
      expect(field(label)).toHaveAttribute("aria-invalid", "true");
      expect(onApply).not.toHaveBeenCalled();
    },
  );

  it("a special-tier customer's real change needs a reason (named in the copy); with one it applies", () => {
    const special: PriceEditLine = { tierPrice: 8, listPrice: 10, tier: 3, qty: 1 };
    const { onApply } = mount({ line: special, customerName: "Acme Foods" });
    open();
    fireEvent.change(field("Price per item"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a reason. Acme Foods has a special price on this item.",
    );
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(field("Reason (optional)"), { target: { value: "damaged" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ unitPrice: 6, reason: "damaged" }),
    );
  });

  it("Cancel and Escape change nothing and hand focus back through onClosed", async () => {
    const { onApply, onClosed } = mount();
    open();
    fireEvent.change(field("Price per item"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(2));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("reopening starts clean (no value, no error, Set price)", () => {
    mount();
    open();
    mode("Percent off");
    fireEvent.change(field("Percent off"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    open();
    expect(screen.getByRole("radio", { name: "Set price" })).toBeChecked();
    expect(field("Price per item")).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
