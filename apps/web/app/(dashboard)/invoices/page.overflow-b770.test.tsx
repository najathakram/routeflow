import * as React from "react";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * B770: the invoices action toolbar (Export / Payments Received / Recurring /
 * New Invoice) rendered as a plain `flex items-center gap-2` row with no wrap.
 * At 390px the row is wider than the viewport, and — because the row isn't
 * itself inside a horizontal-scroll wrapper — the "New Invoice" button (last
 * in DOM order) lands off-screen and unreachable. Fix: wrap, don't clip (same
 * `flex-wrap ... justify-end` pattern as CreateOrderModal's footer row and
 * B749's customers toolbar).
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useInvoiceKpiSummary: () => ({ data: undefined, isLoading: false, isError: false }),
  useDeleteInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useDownloadInvoicePdf: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useBookkeepingSummary: () => ({ data: undefined, isLoading: false, isError: false }),
}));

describe("InvoicesPage — B770 action toolbar wraps instead of overflowing", () => {
  it("New Invoice button row wraps at narrow widths, doesn't overflow off-screen", () => {
    renderWithProviders(<InvoicesPage />);

    // "Payments Received" is unique to the toolbar (the empty-state CTA below
    // the table only offers "New Invoice", which — with no invoices mocked —
    // ALSO renders, so scope through this sibling rather than query
    // "New Invoice" directly and hit both).
    const paymentsReceived = screen.getByRole("button", { name: /payments received/i });
    const actions = paymentsReceived.parentElement!;
    expect(actions).toHaveClass("flex-wrap", "justify-end");
    // Every action stays reachable — none of them got dropped by the fix.
    expect(actions).toContainElement(screen.getByRole("button", { name: /^export$/i }));
    expect(actions).toContainElement(screen.getByRole("button", { name: /^recurring$/i }));
    expect(within(actions).getByRole("button", { name: /new invoice/i })).toBeInTheDocument();
  });
});
