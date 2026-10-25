import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * Row 323: at 390 px the status tab strip was a single nowrap row inside overflow-x-auto, so "Overdue" sat at x 334-413,
 * past the right edge, reachable only by a sideways swipe. The tabs now wrap, so every status is on screen at any width.
 * jsdom has no layout: this pins the structure (wrap on, the clipping scroller off, no nowrap strip, every tab present).
 * The pixel proof (Overdue's right edge <= 390, a hit-test at its centre lands on it) is the browser capture.
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

const TABS = [
  "All",
  "Draft",
  "Sent",
  "Viewed",
  "Partial",
  "Overdue",
  "Paid",
  "Void",
  "Written Off",
];

describe("InvoicesPage: status tabs fit the screen (row 323)", () => {
  it("wraps the strip instead of scrolling it sideways", () => {
    renderWithProviders(<InvoicesPage />);
    const strip = screen.getByRole("button", { name: "Draft" }).parentElement as HTMLElement;
    expect(strip).toHaveClass("flex-wrap");
    expect(strip).not.toHaveClass("overflow-x-auto");
    expect(strip).not.toHaveClass("flex-nowrap");
  });

  it("keeps every status tab inside the strip, Overdue included", () => {
    renderWithProviders(<InvoicesPage />);
    const strip = screen.getByRole("button", { name: "Draft" }).parentElement as HTMLElement;
    for (const label of TABS) {
      const tab = Array.from(strip.querySelectorAll("button")).find((b) => b.textContent === label);
      expect(tab).toBeDefined();
    }
    expect(strip.querySelectorAll("button")).toHaveLength(TABS.length);
  });
});
