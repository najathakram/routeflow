import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { CounterLinePriceEdit, type CounterLinePriceEditProps } from "./CounterLinePriceEdit";
import type { PriceEditLine } from "@/lib/counter-price-edit";

/**
 * SA-1067 M2a (D1-D10, D12): Enter in the price dialog arms; a second Enter on the SAME value applies. A scanner types a
 * code and its Enter, so it can only arm. Apply by pointer, or Tab to Apply and Enter, commits at once.
 */
const plain: PriceEditLine = { tierPrice: 10, listPrice: 10, tier: 1, qty: 2 };
const special: PriceEditLine = { ...plain, tier: 4, isSpecial: true };
const HINT = "Press Enter again to apply.";

function mount(over: Partial<CounterLinePriceEditProps> = {}) {
  const onApply = jest.fn();
  const utils = render(
    <CounterLinePriceEdit
      canEditPrices
      name="Cola"
      line={plain}
      customerName="Acme"
      onApply={onApply}
      {...over}
    />,
  );
  return { ...utils, onApply };
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Change price for Cola" }));
  return screen.findByRole("textbox", { name: "Price per item" });
};

describe("SA-1067 M2a: the price dialog's Enter arms, a second Enter applies", () => {
  it("D1/D2: `4011` Enter applies nothing and shows the hint; the field keeps it; a second Enter applies", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(price).toHaveValue("4011");
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ mode: "set", unitPrice: 4011 });
  });

  it("D3: `4011` Enter `4011` Enter (a second scan) never applies; the field reads 40114011", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}4011{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(price).toHaveValue("40114011");
  });

  it("D4: arming, then editing the Reason and pressing Enter arms again and applies nothing", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "ab{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
  });

  it("D5: a valid price, focus in Reason, a scan `ABC123` Enter applies nothing", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "9");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "ABC123{Enter}");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("D6: an `openWith` prefill that opens the dialog (SA-1071: a special-tier line, an ordinary one applies at once) needs two Enters", async () => {
    const onApply = jest.fn();
    const props = { canEditPrices: true, name: "Cola", line: special, onApply } as const;
    const { rerender } = render(<CounterLinePriceEdit {...props} openWith={null} />);
    rerender(<CounterLinePriceEdit {...props} openWith={{ value: 9 }} />);
    const price = await screen.findByRole("textbox", { name: "Price per item" });
    expect(price).toHaveValue("9.00");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Reason (required)" }), "Matched{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ unitPrice: 9, reason: "Matched" });
  });

  it("D7: `4011` then a click on Apply applies at once", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("D8: Tab to Apply, then Enter applies at once", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "9");
    screen.getByRole("button", { name: "Apply" }).focus();
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("D9: `abc` Enter shows the refusal; a special line with no reason shows its refusal", async () => {
    const user = userEvent.setup();
    const { onApply, unmount } = mount();
    const price = await openDialog(user);
    await user.type(price, "abc{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a price, like 12.50.");
    expect(onApply).not.toHaveBeenCalled();
    unmount();

    const again = mount({ line: special });
    const p2 = await openDialog(user);
    await user.type(p2, "9{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/Add a reason\. Acme has a special price/);
    expect(again.onApply).not.toHaveBeenCalled();
  });

  it("D10: arm, Cancel, reopen, type `4011` Enter: the new session starts disarmed", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const again = await openDialog(user);
    await user.type(again, "4011{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
  });

  it("D12: percent 50 off a $10.00 line applies the same $5.00 after two Enters", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    await openDialog(user);
    await user.click(screen.getByRole("radio", { name: "Percent off" }));
    await user.type(screen.getByRole("textbox", { name: "Percent off" }), "50{Enter}{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ mode: "percent", value: 50, unitPrice: 5 });
  });

  it("D11: 1000000 applies by click; 1000000.01 and a scanned 123456789012 are refused as over the limit, with no preview", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "1000000");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ unitPrice: 1000000 });

    for (const over of ["1000000.01", "123456789012"]) {
      onApply.mockClear();
      const again = await openDialog(user);
      await user.type(again, over);
      expect(screen.queryByText(/New price/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That's over the limit. Enter $1,000,000.00 or less.",
      );
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
  });

  it("D13: 4011 Enter, clear the field, 4011 Enter: not applied, the hint is back", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    await user.clear(price);
    await user.type(price, "4011{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
  });

  it("D14: 4011 Enter, type 5, restore 4011 by hand, Enter: not applied, the hint is back", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    await user.type(price, "5");
    await user.type(price, "{Backspace}");
    expect(price).toHaveValue("4011");
    await user.keyboard("{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
  });

  it("D15: 4011 Enter, abc Enter (refused), restore 4011, Enter: not applied, the hint is back", async () => {
    const user = userEvent.setup();
    const { onApply } = mount();
    const price = await openDialog(user);
    await user.type(price, "4011{Enter}");
    await user.clear(price);
    await user.type(price, "abc{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a price, like 12.50.");
    await user.clear(price);
    await user.type(price, "4011{Enter}");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(HINT))).toBeInTheDocument();
  });
});
