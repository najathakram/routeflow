import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * R4 (SA-770): the Overdue KPI tile showed $35.00 ($30 OVERDUE + $5 owed on a past-due PARTIAL) but the
 * Overdue tab / tile click listed only the strict-status OVERDUE invoice, because the list query sent
 * `status=OVERDUE`. The tab must ask for the derived overdue set instead (`isOverdue=true`, no `status`),
 * for the list AND the CSV export, while the URL keeps `status=OVERDUE` as the UI state.
 */

const mockUseInvoices = jest.fn();
const mockGet = jest.fn();
// A stable object: useUrlFilters memoises on the searchParams identity.
const mockSearchParams = new URLSearchParams("status=OVERDUE");

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => mockSearchParams,
}));

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: (...args: unknown[]) => {
    mockUseInvoices(...args);
    return {
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    };
  },
  useInvoiceKpiSummary: () => ({ data: undefined, isLoading: false, isError: false }),
  useDeleteInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useDownloadInvoicePdf: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useBookkeepingSummary: () => ({ data: undefined, isLoading: false, isError: false }),
}));

jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

jest.mock("@/lib/export", () => ({
  ...jest.requireActual("@/lib/export"),
  downloadCsv: jest.fn(),
}));

describe("InvoicesPage — Overdue tab uses the derived overdue set (R4)", () => {
  beforeEach(() => {
    mockUseInvoices.mockClear();
    mockGet.mockReset();
  });

  it("queries isOverdue=true and no strict status when the Overdue tab is active", () => {
    renderWithProviders(<InvoicesPage />);
    expect(mockUseInvoices).toHaveBeenCalled();
    for (const [params] of mockUseInvoices.mock.calls) {
      expect(params).toEqual(expect.objectContaining({ isOverdue: true }));
      expect(params.status).toBeUndefined();
    }
  });

  it("exports the same derived set (isOverdue=true, no strict status)", async () => {
    mockGet.mockResolvedValue({ data: { data: [], meta: { total: 0 } } });
    renderWithProviders(<InvoicesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const [url, config] = mockGet.mock.calls[0];
    expect(url).toBe("/invoices");
    expect(config.params.isOverdue).toBe(true);
    expect(config.params.status).toBeUndefined();
  });
});
