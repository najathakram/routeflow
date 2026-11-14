import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoicesPage from "./page";

/**
 * SA-1026 A: the invoice list. A "To collect" chip on a row the server marked (staff only, derived, never computed here), one
 * "To collect" filter (server param, also on the export), and the customer chip's link: `?customerId=...&toCollect=true`.
 */
const mockUseInvoices = jest.fn();
const mockGet = jest.fn();
const mockReplace = jest.fn();
let mockQuery = "toCollect=true&customerId=c1";
let mockRows: unknown[] = [];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(mockQuery),
}));

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: (...args: unknown[]) => {
    mockUseInvoices(...args);
    return {
      data: { data: mockRows, meta: { total: mockRows.length, page: 1, limit: 20, totalPages: 1 } },
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

const row = (id: string, toCollect?: string) => ({
  id,
  invoiceNumber: `INV-${id}`,
  status: "SENT",
  total: 25,
  amountPaid: 0,
  balanceDue: 25,
  dueDate: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Co" },
  ...(toCollect ? { toCollect } : {}),
});

beforeEach(() => {
  mockUseInvoices.mockClear();
  mockGet.mockReset();
  mockReplace.mockClear();
  mockQuery = "toCollect=true&customerId=c1";
  mockRows = [];
});
afterEach(() => seedSession(null));

describe("REG-B1 InvoicesPage write surfaces by role", () => {
  // A seeded session makes the i18n provider fetch /users/me/preferences through this file's apiClient mock.
  beforeEach(() => mockGet.mockResolvedValue({ data: {} }));

  it("REG-B1 a CUSTOMER gets no row Print invoice button", () => {
    seedSession("CUSTOMER");
    mockQuery = "";
    mockRows = [row("a")];
    renderWithProviders(<InvoicesPage />);
    const n = screen.queryAllByRole("button", { name: /^Print invoice/ }).length;
    expect({ label: "Print invoice", count: n }).toEqual({ label: "Print invoice", count: 0 });
  });

  it("REG-B1 a CUSTOMER's empty state has no New invoice button", () => {
    seedSession("CUSTOMER");
    mockQuery = "";
    mockRows = [];
    renderWithProviders(<InvoicesPage />);
    const n = screen.queryAllByRole("button", { name: /^New invoice$/ }).length;
    expect({ label: "New invoice", count: n }).toEqual({ label: "New invoice", count: 0 });
  });

  it("REG-B1 an OPERATOR twin keeps the row Print invoice button and the empty-state New invoice", () => {
    seedSession("OPERATOR");
    mockQuery = "";
    mockRows = [row("a")];
    const first = renderWithProviders(<InvoicesPage />);
    expect(
      screen.queryAllByRole("button", { name: /^Print invoice/ }).length,
    ).toBeGreaterThanOrEqual(1);
    first.unmount();
    mockRows = [];
    renderWithProviders(<InvoicesPage />);
    expect(
      screen.queryAllByRole("button", { name: /^New invoice$/ }).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("InvoicesPage: To collect (SA-1026)", () => {
  it("asks the server for the To collect set of that customer", () => {
    renderWithProviders(<InvoicesPage />);
    for (const [params] of mockUseInvoices.mock.calls) {
      expect(params).toEqual(expect.objectContaining({ toCollect: true, customerId: "c1" }));
    }
  });

  it("exports the same set", async () => {
    mockGet.mockResolvedValue({ data: { data: [], meta: { total: 0 } } });
    renderWithProviders(<InvoicesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockGet.mock.calls[0][1].params).toEqual(
      expect.objectContaining({ toCollect: true, customerId: "c1" }),
    );
  });

  it("sends neither param when the filter is off", () => {
    mockQuery = "";
    renderWithProviders(<InvoicesPage />);
    for (const [params] of mockUseInvoices.mock.calls) {
      expect(params.toCollect).toBeUndefined();
      expect(params.customerId).toBeUndefined();
    }
  });

  it("has one To collect filter: pressed when on, and pressing it off clears the param", () => {
    renderWithProviders(<InvoicesPage />);
    const chip = screen.getByRole("button", { name: "To collect" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(mockReplace).toHaveBeenCalled();
    expect(String(mockReplace.mock.calls.at(-1)?.[0])).not.toContain("toCollect=true");
  });

  it("pressing it on sets the param", () => {
    mockQuery = "";
    renderWithProviders(<InvoicesPage />);
    const chip = screen.getByRole("button", { name: "To collect" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(String(mockReplace.mock.calls.at(-1)?.[0])).toContain("toCollect=true");
  });

  it("a row the server marked carries the chip; an unmarked row does not", () => {
    mockQuery = "";
    mockRows = [row("a", "TO_COLLECT"), row("b", "NONE"), row("c")];
    renderWithProviders(<InvoicesPage />);
    const rows = screen.getAllByRole("row");
    const mark = (n: string) => rows.find((r) => within(r).queryByText(`INV-${n}`))!;
    expect(within(mark("a")).getByText("To collect")).toBeInTheDocument();
    expect(within(mark("b")).queryByText("To collect")).toBeNull();
    expect(within(mark("c")).queryByText("To collect")).toBeNull();
  });
});
