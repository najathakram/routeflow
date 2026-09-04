import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import TransactionDetailPage from "./page";

const txn = {
  id: "txn-1",
  totalOwed: 500,
  totalPaid: 100,
  payments: [],
  order: { orderNumber: "ORD-100" },
  customer: { businessName: "Acme Foods", contactName: "Jane" },
  createdAt: new Date("2026-01-01").toISOString(),
  dueDate: null,
};

const recordPaymentMutate = jest.fn();
jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useTransaction: () => ({ data: txn, isLoading: false, isError: false }),
  useRecordPayment: () => ({ mutate: recordPaymentMutate, isPending: false }),
  useDownloadInvoice: () => ({ isPending: false }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

describe("TransactionDetailPage — RecordPaymentModal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls the record-payment mutation on an invalid amount", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionDetailPage params={{ transactionId: "txn-1" }} />);

    // "Record Payment" appears twice on the page (action row + sidebar) before
    // the modal opens — open via the first one.
    await user.click(screen.getAllByRole("button", { name: /^record payment$/i })[0]);
    const dialog = within(await screen.findByRole("dialog"));

    await user.clear(dialog.getByLabelText("Amount ($)"));
    await user.click(dialog.getByRole("button", { name: /^record payment$/i }));

    expect(await dialog.findByText("Enter an amount greater than 0")).toBeInTheDocument();
    expect(recordPaymentMutate).not.toHaveBeenCalled();
  });

  it("records a payment pre-filled with the outstanding balance", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionDetailPage params={{ transactionId: "txn-1" }} />);

    await user.click(screen.getAllByRole("button", { name: /^record payment$/i })[0]);
    const dialog = within(await screen.findByRole("dialog"));

    // Default method ACH, amount pre-filled with the $400 balance due.
    await waitFor(() => expect(dialog.getByLabelText("Amount ($)")).toHaveValue(400));
    await user.click(dialog.getByRole("button", { name: /^record payment$/i }));

    await waitFor(() => {
      expect(recordPaymentMutate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "txn-1", amount: 400, method: "ACH" }),
        expect.anything(),
      );
    });
  });
});
