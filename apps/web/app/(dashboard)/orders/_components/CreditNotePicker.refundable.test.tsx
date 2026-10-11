/**
 * SA-773 (S1): the inline "+ New credit note" form of the order credit picker shows how much is still creditable when the server
 * refuses the credit for goods that were already returned or credited (CREDIT_EXCEEDS_REFUNDABLE), from the structured body:
 * fixed copy plus "Up to $X", never the server message.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";

const mutate = jest.fn();
jest.mock("@/lib/api/credit-notes", () => ({
  useCreditNotes: () => ({ data: { data: [] } }),
  useCreateCreditNote: () => ({ mutate, isPending: false }),
  openCreditBalance: () => 0,
}));

import { CreditNotePicker } from "./CreditNotePicker";
import { CREDIT_EXCEEDS_REFUNDABLE_COPY } from "@/lib/credit-note-error-copy";

const apiError = (data: Record<string, unknown>) => ({
  response: { data: { message: "RAW SERVER TEXT", ...data } },
});

async function submitFailing(err: unknown) {
  mutate.mockImplementation((_vars: unknown, opts: any) => opts.onError(err));
  const user = userEvent.setup();
  render(<CreditNotePicker customerId="cust-1" value={[]} onChange={jest.fn()} />);
  await user.click(screen.getByRole("button", { name: "+ New credit note" }));
  await user.type(screen.getByPlaceholderText("0.00"), "20");
  await user.type(screen.getByPlaceholderText("e.g. Damaged goods"), "Damaged");
  await user.click(screen.getByRole("button", { name: "Create" }));
}

describe("CreditNotePicker create form: CREDIT_EXCEEDS_REFUNDABLE (SA-773)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the fixed copy and how much is still creditable", async () => {
    await submitFailing(apiError({ code: "CREDIT_EXCEEDS_REFUNDABLE", remainingValue: 12 }));
    expect(
      await screen.findByText(
        `${CREDIT_EXCEEDS_REFUNDABLE_COPY} Up to $12.00 can still be given back.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
  });

  it("without a usable amount in the body it shows the fixed copy alone", async () => {
    await submitFailing(apiError({ code: "CREDIT_EXCEEDS_REFUNDABLE", remainingValue: "12" }));
    expect(await screen.findByText(CREDIT_EXCEEDS_REFUNDABLE_COPY)).toBeInTheDocument();
  });
});
