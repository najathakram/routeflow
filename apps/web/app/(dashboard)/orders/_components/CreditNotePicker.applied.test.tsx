/**
 * #2404 (P0, epic #2400): in edit mode the credit picker listed only credits with an open balance
 * plus the current picks, so a credit the send AUTO-applied to this order's invoices (no pick)
 * was invisible there, or looked like a fresh, unticked credit. The picker now shows those as a
 * read-only "already on this order's invoices" list, pointing at Remove in Applied credits.
 */
import * as React from "react";
import { render, screen, within } from "@testing-library/react";

jest.mock("@/lib/api/credit-notes", () => ({
  useCreditNotes: () => ({ data: { data: [] } }),
  useCreateCreditNote: () => ({ mutate: jest.fn(), isPending: false }),
  openCreditBalance: () => 0,
}));

import { CreditNotePicker } from "./CreditNotePicker";

const applied = [
  {
    kind: "applied" as const,
    key: "payment:p1",
    paymentId: "p1",
    creditNoteId: "cn-a",
    creditNoteNumber: "CN-A",
    reason: "old test credit",
    invoiceId: "inv-1",
    invoiceNumber: "INV-1",
    amount: 12.5,
    pairTotal: 12.5,
    source: "automatic" as const,
  },
  {
    kind: "applied" as const,
    key: "payment:p2",
    paymentId: "p2",
    creditNoteId: "cn-b",
    creditNoteNumber: "CN-B",
    reason: null,
    invoiceId: "inv-1",
    invoiceNumber: "INV-1",
    amount: 5,
    source: "applied" as const,
    pairTotal: 5,
  },
];

describe("CreditNotePicker — credits already on the order (#2404)", () => {
  it("lists applied credits that are not picks, read-only, with Automatic / Applied", () => {
    render(
      <CreditNotePicker
        customerId="cust-1"
        value={[{ creditNoteId: "cn-b" }]}
        onChange={jest.fn()}
        appliedOnOrder={applied}
      />,
    );
    const box = screen.getByTestId("picker-applied-on-order");
    expect(within(box).getByText(/CN-A/)).toBeTruthy();
    expect(within(box).getByText(/Automatic/)).toBeTruthy();
    expect(within(box).getByText(/INV-1/)).toBeTruthy();
    expect(within(box).getByText(/\$12\.50/)).toBeTruthy();
    // cn-b is a pick: it already has its own checkbox row, so it is not repeated here.
    expect(within(box).queryByText(/CN-B/)).toBeNull();
    expect(within(box).queryByRole("checkbox")).toBeNull();
  });

  it("shows nothing extra when every applied credit is a pick, or none were passed", () => {
    const { rerender } = render(
      <CreditNotePicker customerId="cust-1" value={[]} onChange={jest.fn()} />,
    );
    expect(screen.queryByTestId("picker-applied-on-order")).toBeNull();
    rerender(
      <CreditNotePicker
        customerId="cust-1"
        value={[{ creditNoteId: "cn-a" }, { creditNoteId: "cn-b" }]}
        onChange={jest.fn()}
        appliedOnOrder={applied}
      />,
    );
    expect(screen.queryByTestId("picker-applied-on-order")).toBeNull();
  });
});
