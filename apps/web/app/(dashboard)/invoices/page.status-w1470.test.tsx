import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * W-1470 (S-1, S-2, S-3): the invoices list reads the ONE invoice status rule. A SENT invoice the server calls overdue is
 * "Overdue by N days" (it used to read "Sent"), the day counts are against the TENANT's day (never the browser's clock),
 * and while the tenant day is unknown no count is claimed.
 */
let mockTenantDay: string | undefined;
let mockRole = "ADMIN";
const mockTenantEnabled: (boolean | undefined)[] = [];
const mockUseInvoices = jest.fn();

jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: (enabled?: boolean) => {
    mockTenantEnabled.push(enabled);
    return enabled === false ? undefined : mockTenantDay;
  },
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole } }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
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

function row(overrides: Record<string, unknown>) {
  return {
    customerId: "cust-1",
    status: "SENT",
    subtotal: 100,
    total: 100,
    balanceDue: 100,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    issueDate: "2026-11-01T00:00:00.000Z",
    customer: { businessName: "Acme Foods" },
    ...overrides,
  };
}

function setRows(rows: Record<string, unknown>[]) {
  mockUseInvoices.mockReturnValue({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  });
}

/** Only the clock moves: timers stay real so queries and effects run. */
function setBrowserClock(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "nextTick",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "performance",
    ],
  });
}

const cardOf = (container: HTMLElement) => {
  const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
  return within(list).getAllByRole("listitem")[0];
};

describe("InvoicesPage status word (W-1470)", () => {
  beforeEach(() => {
    mockTenantDay = "2026-11-26";
    mockRole = "ADMIN";
    mockTenantEnabled.length = 0;
    mockUseInvoices.mockReset();
  });

  /** R-356 F1 (lead ruling 7210882888): a CUSTOMER on this list sees exactly master's word and class. */
  function customerCell(inv: Parameters<typeof row>[0]) {
    mockRole = "CUSTOMER";
    setBrowserClock("2026-11-26T12:00:00");
    setRows([row(inv)]);
    const { container } = renderWithProviders(<InvoicesPage />);
    const cell = cardOf(container).querySelector("[data-invoice-status]") as HTMLElement;
    return { cell, container };
  }

  it.each([
    // master: "Partial · Overdue by 10 days" text-danger (the amber "Partial" is the regression)
    [
      "an overdue partly paid invoice",
      "PARTIAL",
      "2026-11-16T00:00:00.000Z",
      "Partial · Overdue by 10 days",
      "text-danger",
    ],
    // master: Viewed, brand-700 (staff now read the shared blue)
    ["a viewed invoice", "VIEWED", "2026-12-20T00:00:00.000Z", "Viewed", "text-brand-700"],
    // master: Written off, navy/50 (staff now read stone)
    [
      "a written-off invoice",
      "WRITTEN_OFF",
      "2026-11-01T00:00:00.000Z",
      "Written off",
      "text-navy/50",
    ],
    // master: a past-due Sent still read "Sent" for this list (no server flag on Sent)
    ["a past-due sent invoice", "SENT", "2026-11-16T00:00:00.000Z", "Sent", "text-brand-600"],
  ])("R-356 F1: a CUSTOMER sees %s exactly as on master", (_name, status, dueDate, word, cls) => {
    const { cell } = customerCell({
      id: "inv-1",
      invoiceNumber: "INV-1",
      status,
      dueDate,
      isOverdue: true,
    });
    expect(cell).toHaveTextContent(word);
    expect(cell.textContent).toBe(word);
    expect(cell.className).toContain(cls);
    expect(cell.className).not.toContain("text-warning");
  });

  it("R-356 F1: a CUSTOMER never asks for the tenant day and gets no status key", () => {
    const { container } = customerCell({
      id: "inv-1",
      invoiceNumber: "INV-1",
      status: "PARTIAL",
      dueDate: "2026-11-16T00:00:00.000Z",
      isOverdue: true,
    });
    expect(mockTenantEnabled.length).toBeGreaterThan(0);
    expect(mockTenantEnabled.every((e) => e === false)).toBe(true);
    expect(within(container).queryByText("Status key")).toBeNull();
  });
  afterEach(() => jest.useRealTimers());

  it("S-1: a SENT invoice the server calls overdue reads 'Overdue by 10 days' in the danger tone", () => {
    setRows([
      row({
        id: "inv-1",
        invoiceNumber: "INV-1",
        status: "SENT",
        dueDate: "2026-11-16T00:00:00.000Z",
        isOverdue: true,
      }),
    ]);
    const { container } = renderWithProviders(<InvoicesPage />);
    const card = cardOf(container);
    const word = within(card).getByText("Overdue by 10 days");
    expect(word).toHaveAttribute("data-tone", "danger");
    expect(within(card).queryByText("Sent")).toBeNull();
  });

  it("S-2: due today is the tenant's day, even when the browser clock is a day ahead", () => {
    setBrowserClock("2026-11-27T12:00:00Z");
    setRows([
      row({
        id: "inv-2",
        invoiceNumber: "INV-2",
        status: "PARTIAL",
        dueDate: "2026-11-26T00:00:00.000Z",
        isOverdue: false,
      }),
    ]);
    const { container } = renderWithProviders(<InvoicesPage />);
    const word = within(cardOf(container)).getByText("Partial · Due today");
    expect(word).toHaveAttribute("data-tone", "warning");
  });

  it("S-3: with the tenant day unknown a flagged invoice reads 'Overdue' with no number", () => {
    mockTenantDay = undefined;
    setRows([
      row({
        id: "inv-3",
        invoiceNumber: "INV-3",
        status: "SENT",
        dueDate: "2026-11-16T00:00:00.000Z",
        isOverdue: true,
      }),
    ]);
    const { container } = renderWithProviders(<InvoicesPage />);
    const card = cardOf(container);
    expect(within(card).getByText("Overdue")).toBeInTheDocument();
    expect(within(card).queryByText(/by \d+ day/)).toBeNull();
  });

  it("a sent invoice that is not due reads Sent in the blue (info) tone", () => {
    setRows([
      row({
        id: "inv-4",
        invoiceNumber: "INV-4",
        status: "SENT",
        dueDate: "2026-12-30T00:00:00.000Z",
        isOverdue: false,
      }),
    ]);
    const { container } = renderWithProviders(<InvoicesPage />);
    expect(within(cardOf(container)).getByText("Sent")).toHaveAttribute("data-tone", "info");
  });

  it("the status key opens on request and shows each status once in enum order", async () => {
    setRows([row({ id: "inv-5", invoiceNumber: "INV-5", dueDate: "2026-12-30T00:00:00.000Z" })]);
    renderWithProviders(<InvoicesPage />);
    expect(document.querySelector("[data-legend-status]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /status key/i }));
    const items = Array.from(document.querySelectorAll("[data-legend-status]")).map((el) =>
      el.getAttribute("data-legend-status"),
    );
    expect(items).toEqual([
      "DRAFT",
      "SENT",
      "VIEWED",
      "PARTIAL",
      "PAID",
      "OVERDUE",
      "VOID",
      "WRITTEN_OFF",
    ]);
  });
});
