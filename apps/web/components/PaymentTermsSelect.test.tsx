import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";
import { PaymentTermsSelect } from "./PaymentTermsSelect";

/** W-1487 B-7: the terms field offers Net 7 and Net 90 and takes a typed number of days; 0 and 366 are refused inline. */
function Harness({ initial = "", onChange }: { initial?: string; onChange: (v: string) => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <PaymentTermsSelect
      value={value}
      emptyLabel="Use tenant default"
      aria-label="Payment terms"
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe("PaymentTermsSelect (B-7)", () => {
  it("offers every preset including Net 7 and Net 90, plus a custom choice", () => {
    render(<Harness onChange={jest.fn()} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual([
      "Use tenant default",
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
      "Custom (Net N)…",
    ]);
  });

  it("picking Net 7 reports the label", async () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("Payment terms"), "Net 7");
    expect(onChange).toHaveBeenLastCalledWith("Net 7");
  });

  const pickCustom = async () =>
    userEvent.selectOptions(screen.getByLabelText("Payment terms"), "Custom (Net N)…");

  it("21 typed key by key then Enter reports exactly one Net 21", async () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await pickCustom();
    await userEvent.type(screen.getByLabelText("Number of days"), "21");
    expect(onChange).not.toHaveBeenCalled(); // nothing while typing
    await userEvent.type(screen.getByLabelText("Number of days"), "{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Net 21");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("45 typed key by key then blur reports exactly one Net 45 (never Net 4)", async () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await pickCustom();
    await userEvent.type(screen.getByLabelText("Number of days"), "45");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Net 45");
  });

  it.each(["0", "366"])(
    "%s typed key by key is refused inline and never reported",
    async (typed) => {
      const onChange = jest.fn();
      render(<Harness onChange={onChange} />);
      await pickCustom();
      await userEvent.type(screen.getByLabelText("Number of days"), typed);
      await userEvent.tab();
      expect(screen.getByRole("alert")).toHaveTextContent("1 to 365");
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("Enter then blur (value not refetched yet) reports ONE Net 21", async () => {
    const onChange = jest.fn();
    render(<PaymentTermsSelect value="Net 30" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "Custom (Net N)…");
    await userEvent.type(screen.getByLabelText("Number of days"), "21{Enter}");
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Net 21");
  });

  it("a parent value arriving while the user types does not overwrite the box", async () => {
    const { rerender } = render(<PaymentTermsSelect value="Net 21" onChange={jest.fn()} />);
    const box = screen.getByLabelText("Number of days");
    await userEvent.clear(box);
    await userEvent.type(box, "4");
    rerender(<PaymentTermsSelect value="Net 21" onChange={jest.fn()} />);
    expect(box).toHaveValue(4);
  });

  it("a stored custom label shows as Custom with its days filled in", () => {
    render(<Harness initial="Net 21" onChange={jest.fn()} />);
    expect(screen.getByLabelText("Number of days")).toHaveValue(21);
    expect(screen.getByLabelText("Payment terms")).toHaveDisplayValue("Custom (Net N)…");
  });
});

describe("R-345 F6: a create or edit form holds submit while the custom box shows an error", () => {
  it("reports invalid on a refused number and valid again once fixed or a preset is picked", async () => {
    const onInvalidChange = jest.fn();
    render(
      <PaymentTermsSelect
        value="Net 30"
        aria-label="Payment terms"
        onChange={jest.fn()}
        onInvalidChange={onInvalidChange}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Payment terms"), "Custom (Net N)…");
    await userEvent.type(screen.getByLabelText("Number of days"), "366");
    await userEvent.tab();
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    await userEvent.clear(screen.getByLabelText("Number of days"));
    await userEvent.type(screen.getByLabelText("Number of days"), "21");
    await userEvent.tab();
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    await userEvent.clear(screen.getByLabelText("Number of days"));
    await userEvent.type(screen.getByLabelText("Number of days"), "0");
    await userEvent.tab();
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    await userEvent.selectOptions(screen.getByLabelText("Payment terms"), "Net 7");
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
  });

  const APP = path.resolve(__dirname, "..", "app", "(dashboard)");
  it.each([
    [
      "orders/_components/SplitInvoiceModal.tsx",
      "disabled={billable.length === 0 || termsInvalid}",
    ],
    ["invoices/new/page.tsx", "const saveBlocked = priceBlocked || termsInvalid;"],
    [
      "invoices/[id]/edit/page.tsx",
      "disabled={updateInvoice.isPending || priceBlocked || termsInvalid}",
    ],
  ])("%s wires onInvalidChange into its submit", (file, hold) => {
    const src = fs.readFileSync(path.join(APP, file), "utf8");
    expect(src).toContain("onInvalidChange={setTermsInvalid}");
    expect(src).toContain(hold);
  });
});
