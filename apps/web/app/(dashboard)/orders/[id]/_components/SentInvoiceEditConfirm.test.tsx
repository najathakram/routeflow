import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useSentInvoiceEditConfirm } from "./SentInvoiceEditConfirm";
import { editRevertsSentCopy } from "@/lib/edit-reverts-sent";

/**
 * B1372 (SA-1177 K2, owner box Q2 "Warn, re-send at hand-over"): before an items edit turns an already-sent invoice back
 * into a draft, the staff confirm it ([Edit anyway] · [Cancel]). The invoice numbers are the order read's
 * `editRevertsSentInvoices`; nothing is re-derived here. Placeholders only.
 */
function Harness({
  numbers,
  active = true,
  save,
}: {
  numbers?: string[];
  active?: boolean;
  save: () => void;
}) {
  const confirm = useSentInvoiceEditConfirm(numbers, active);
  const onSave = () => {
    if (confirm.ask(onSave)) return;
    save();
  };
  return (
    <>
      <button onClick={onSave}>Save</button>
      {confirm.dialog}
    </>
  );
}

describe("editRevertsSentCopy (B1372 K2)", () => {
  it("one invoice: the SA-1177 sentence", () => {
    expect(editRevertsSentCopy(["INV-2026-0007"])).toBe(
      "Invoice INV-2026-0007 was already sent. This edit turns it back into a draft. " +
        "It is sent again when the order is handed over or delivered.",
    );
  });

  it("several invoices: plural, every number named", () => {
    expect(editRevertsSentCopy(["INV-1", "INV-1-R1", "INV-2"])).toBe(
      "Invoices INV-1, INV-1-R1 and INV-2 were already sent. This edit turns them back into drafts. " +
        "They are sent again when the order is handed over or delivered.",
    );
  });

  it("nothing reverts: no confirm", () => {
    expect(editRevertsSentCopy([])).toBeNull();
    expect(editRevertsSentCopy(undefined)).toBeNull();
  });
});

describe("useSentInvoiceEditConfirm (B1372 K2)", () => {
  it("a sent invoice reverts: Save opens the confirm and saves nothing; Cancel keeps it unsaved", () => {
    const save = jest.fn();
    render(<Harness numbers={["INV-1"]} save={save} />);
    fireEvent.click(screen.getByText("Save"));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/Invoice INV-1 was already sent\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("Edit anyway saves once, and a retry in the same editing session is not asked again", () => {
    const save = jest.fn();
    render(<Harness numbers={["INV-1"]} save={save} />);
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Save"));
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Edit anyway" })).toBeNull();
  });

  it("leaving edit mode resets it: the next editing session asks again", () => {
    const save = jest.fn();
    const { rerender } = render(<Harness numbers={["INV-1"]} save={save} />);
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    rerender(<Harness numbers={["INV-1"]} active={false} save={save} />);
    rerender(<Harness numbers={["INV-1"]} active save={save} />);
    fireEvent.click(screen.getByText("Save"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Edit anyway" })).toBeInTheDocument();
  });

  it("nothing reverts: Save goes straight through, no confirm", () => {
    const save = jest.fn();
    render(<Harness numbers={[]} save={save} />);
    fireEvent.click(screen.getByText("Save"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Edit anyway" })).toBeNull();
  });
});
