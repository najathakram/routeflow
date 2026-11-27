import * as React from "react";
import { render } from "@testing-library/react";
import { INVOICE_STATUS_VALUES, INVOICE_STATUS_TONE } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { renderInvoiceStatus } from "../customers/[id]/invoice-status-badge";
import FinanceReportsPage from "../finance/reports/page";
import InvoicesPage from "./page";

/**
 * W-1470 (S-5, S-6): one status, one tone. For every InvoiceStatus the invoices list, the customer page badge and the
 * finance reports badge paint the tone the shared table gives it. Before: VIEWED was brand on the list, purple on the
 * customer page and grey on the reports; WRITTEN_OFF had no tone on the reports.
 */
let mockSearch = "report=ar-aging-details";
let mockDetails: Record<string, unknown>[] = [];
const mockUseInvoices = jest.fn();

jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => undefined,
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/x",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "ADMIN" } }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api/finance", () => ({
  ...jest.requireActual("@/lib/api/finance"),
  useArAgingDetails: () => ({
    data: { data: mockDetails },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: [] }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: (...args: unknown[]) => mockUseInvoices(...args),
  useInvoiceKpiSummary: () => ({ data: undefined }),
  useDeleteInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useBookkeepingSummary: () => ({ data: undefined }),
}));

const DUE = "2099-02-05T00:00:00.000Z";

const tonesOn = (root: ParentNode, status: string) =>
  Array.from(root.querySelectorAll(`[data-invoice-status="${status}"]`)).map((el) =>
    el.getAttribute("data-tone"),
  );

describe("one status, one tone across the staff screens (S-5)", () => {
  it.each(INVOICE_STATUS_VALUES)("%s: list, customer badge and reports agree", async (status) => {
    const want = INVOICE_STATUS_TONE[status];

    // invoices list (table and phone cards both render the row)
    mockSearch = "";
    mockUseInvoices.mockReturnValue({
      data: {
        data: [
          {
            id: "inv-1",
            invoiceNumber: "INV-1",
            customerId: "c1",
            status,
            subtotal: 10,
            total: 10,
            balanceDue: 10,
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            issueDate: "2026-11-01T00:00:00.000Z",
            dueDate: DUE,
            customer: { businessName: "Acme Foods" },
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    });
    const list = renderWithProviders(<InvoicesPage />);
    const onList = tonesOn(list.container, status);
    expect(onList.length).toBeGreaterThan(0);
    expect(new Set(onList)).toEqual(new Set([want]));
    list.unmount();

    // customer page badge
    const badge = render(<>{renderInvoiceStatus(status, DUE, { tenantDay: "2026-11-26" })}</>);
    expect(tonesOn(badge.container, status)).toEqual([want]);
    badge.unmount();

    // finance reports badge
    mockSearch = "report=ar-aging-details";
    mockDetails = [
      {
        id: "d1",
        date: "2026-10-01T00:00:00.000Z",
        dueDate: DUE,
        invoiceNumber: "INV-D1",
        status,
        customerName: "Acme Co",
        ageDays: 0,
        amount: 10,
        balance: 10,
      },
    ];
    renderWithProviders(<FinanceReportsPage />);
    const rowEl = (await screen.findByText("INV-D1")).closest("tr")!;
    expect(tonesOn(rowEl, status)).toEqual([want]);
  });
});

describe("finance reports (S-6)", () => {
  it("VIEWED reads 'Viewed' in the info tone; WRITTEN_OFF reads 'Written off' with its own tone", async () => {
    mockSearch = "report=ar-aging-details";
    mockDetails = ["VIEWED", "WRITTEN_OFF"].map((status, i) => ({
      id: `d${i}`,
      date: "2026-10-01T00:00:00.000Z",
      dueDate: DUE,
      invoiceNumber: `INV-S${i}`,
      status,
      customerName: "Acme Co",
      ageDays: 0,
      amount: 10,
      balance: 10,
    }));
    renderWithProviders(<FinanceReportsPage />);
    const viewed = (await screen.findByText("INV-S0")).closest("tr")!;
    const off = screen.getByText("INV-S1").closest("tr")!;
    expect(within(viewed).getByText("Viewed")).toHaveAttribute("data-tone", "info");
    const offWord = within(off).getByText("Written off");
    expect(offWord).toHaveAttribute("data-tone", INVOICE_STATUS_TONE.WRITTEN_OFF);
    expect(INVOICE_STATUS_TONE.WRITTEN_OFF).not.toBe("neutral");
  });
});
