import * as React from "react";
import { render, screen } from "@testing-library/react";
import { AppliedCreditsSection } from "./AppliedCreditsSection";
import type { Order } from "@/lib/api/orders";

// #2600 (SA-484f/g): the "Applied credits" row names the credit note's total when the order only
// requests part of it — built from the two server figures (oc.amount, oc.creditNote.amount).
const orderWith = (oc: Record<string, unknown>) =>
  ({
    id: "o1",
    invoices: [],
    orderCreditNotes: [
      {
        id: "ocn-1",
        creditNoteId: "cn-1",
        creditNote: { id: "cn-1", creditNoteNumber: "CN-1", amountUsed: 0 },
        ...oc,
      },
    ],
  }) as unknown as Order;

describe("AppliedCreditsSection — the requested label (#2600)", () => {
  it("intent below the credit note's total: 'Requested $X of $Y (the rest stays as store credit)'", () => {
    render(
      <AppliedCreditsSection
        order={orderWith({
          amount: "6.99",
          creditNote: { id: "cn-1", creditNoteNumber: "CN-1", amount: "14.97", amountUsed: 0 },
        })}
      />,
    );
    expect(
      screen.getByText("Requested $6.99 of $14.97 (the rest stays as store credit)"),
    ).toBeInTheDocument();
  });

  it("intent equal to the credit note's total: today's 'Requested $X'", () => {
    render(
      <AppliedCreditsSection
        order={orderWith({
          amount: 14.97,
          creditNote: { id: "cn-1", creditNoteNumber: "CN-1", amount: 14.97, amountUsed: 0 },
        })}
      />,
    );
    expect(screen.getByText("Requested $14.97")).toBeInTheDocument();
    expect(screen.queryByText(/the rest stays as store credit/)).not.toBeInTheDocument();
  });

  it("credit note amount absent: today's 'Requested $X' (never invented)", () => {
    render(<AppliedCreditsSection order={orderWith({ amount: 6.99, creditNote: undefined })} />);
    expect(screen.getByText("Requested $6.99")).toBeInTheDocument();
  });

  it("no intent: 'Up to remaining' unchanged", () => {
    render(<AppliedCreditsSection order={orderWith({ amount: null })} />);
    expect(screen.getByText("Up to remaining")).toBeInTheDocument();
  });
});
