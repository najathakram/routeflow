import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * B750: the invoices list table sat inside a bare `overflow-hidden` card, so
 * at 390px (many columns wider than the viewport) it CLIPPED instead of
 * scrolling — content past the fold was simply cut off, unreachable. Fix: an
 * inner `overflow-x-auto` wrapper around the `<table>` (the outer div keeps
 * `overflow-hidden` only for its rounded corners), the same pattern the
 * orders list table already uses.
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

describe("InvoicesPage — B750 table scrolls instead of clipping at narrow widths", () => {
  it("the table sits inside an overflow-x-auto wrapper, not a bare overflow-hidden card", () => {
    renderWithProviders(<InvoicesPage />);

    const table = screen.getByRole("table");
    const scrollWrapper = table.parentElement!;
    expect(scrollWrapper).toHaveClass("overflow-x-auto");
    // The rounded-corner card is still the outer wrapper — B750's fix adds a
    // layer, it doesn't replace the card.
    expect(scrollWrapper.parentElement).toHaveClass("overflow-hidden", "rounded-lg");
  });
});
