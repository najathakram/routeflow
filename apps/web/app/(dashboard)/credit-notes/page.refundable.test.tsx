/**
 * SA-773 (S1): the "New Credit Note" form on the credit notes page toasts how much is still creditable when the server refuses a
 * credit for goods that were already returned or credited (CREDIT_EXCEEDS_REFUNDABLE): fixed copy plus "Up to $X" from the
 * structured body, never the server message. Any other failure keeps today's line.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within, waitFor } from "@/test-utils/render";

const mutate = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/credit-notes",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/credit-notes", () => ({
  useCreditNotes: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useCreateCreditNote: () => ({ mutate, isPending: false }),
  openCreditBalance: () => 0,
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Retail" }] } }),
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: () => ({ data: { data: [] } }),
  useInvoice: () => ({ data: undefined }),
}));

import CreditNotesPage from "./page";
import { CREDIT_EXCEEDS_REFUNDABLE_COPY } from "@/lib/credit-note-error-copy";

async function submitFailing(err: unknown) {
  mutate.mockImplementation((_vars: unknown, opts: any) => opts.onError(err));
  const user = userEvent.setup();
  renderWithProviders(<CreditNotesPage />);
  await user.click(screen.getByRole("button", { name: /New Credit Note/ }));
  const dialog = within(await screen.findByRole("dialog"));
  await user.type(dialog.getByPlaceholderText("Search by business name…"), "Acme");
  await user.click(await dialog.findByRole("button", { name: /Acme Retail/ }));
  await user.type(dialog.getByPlaceholderText("0.00"), "20");
  await user.type(dialog.getByPlaceholderText("Reason for credit note…"), "Damaged");
  await user.click(dialog.getByRole("button", { name: "Create Credit Note" }));
}

describe("credit notes page, New Credit Note: CREDIT_EXCEEDS_REFUNDABLE (SA-773)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("toasts the fixed copy and how much is still creditable, never the server message", async () => {
    await submitFailing({
      response: {
        data: { code: "CREDIT_EXCEEDS_REFUNDABLE", message: "RAW SERVER TEXT", remainingValue: 12 },
      },
    });
    await waitFor(() =>
      expect(
        screen.getByText(`${CREDIT_EXCEEDS_REFUNDABLE_COPY} Up to $12.00 can still be given back.`),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
  });

  it("any other failure keeps today's line", async () => {
    await submitFailing({
      response: { data: { code: "SOMETHING_ELSE", message: "RAW SERVER TEXT" } },
    });
    await waitFor(() => expect(screen.getByText("Please try again.")).toBeInTheDocument());
  });
});
