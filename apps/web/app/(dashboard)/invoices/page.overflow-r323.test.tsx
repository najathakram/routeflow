import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * Row 323: at 390px the status tab row was a no-wrap, scrollbar-hidden scroller, so the "Overdue"
 * tab sat past the right edge (x 334-413) with no hint it was reachable. Below `sm` the row must
 * wrap (every tab on screen); from `sm` up it scrolls. Tabs keep a 44px tap target.
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

describe("InvoicesPage — row 323 status tabs stay reachable at 390px", () => {
  it("renders Overdue in a wrapping tab row with 44px tap targets", () => {
    renderWithProviders(<InvoicesPage />);
    const overdue = screen
      .getAllByRole("button", { name: "Overdue" })
      .find((el) => el.className.includes("border-b-2"));
    expect(overdue).toBeDefined();
    expect(overdue!.className).toContain("min-h-[44px]");

    const row = overdue!.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("sm:flex-nowrap");
    expect(row.className).not.toMatch(/(^|\s)overflow-x-auto/);
    expect(row.className).not.toMatch(/(^|\s)scrollbar-hide/);
  });
});
