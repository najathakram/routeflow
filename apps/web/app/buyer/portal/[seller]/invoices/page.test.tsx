import * as React from "react";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { invoiceListItem } from "@/test-utils/buyer-invoice-fixtures";
import type { BuyerInvoiceListItem } from "@routeflow/types";
import BuyerInvoicesPage from "./page";

/**
 * Buyer-portal invoices list (B1122). The page used to read `totalAmount ?? amount`, but
 * GET /buyer/invoices carries the invoice's own `total` column, so every AMOUNT cell rendered
 * "N/A". The fixtures below are typed by @routeflow/types (the server's real row shape), so an
 * invented field name fails type-check instead of quietly passing.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push }),
}));

const mockGet = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

function respondWith(rows: BuyerInvoiceListItem[]) {
  mockGet.mockResolvedValue({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
  });
}

/** The text of one row's cell under the named column header. */
function cell(row: HTMLElement, header: string): string {
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  return within(row).getAllByRole("cell")[idx].textContent?.trim() ?? "";
}

async function renderRows() {
  renderWithProviders(<BuyerInvoicesPage />);
  await screen.findByRole("table");
  // rows[0] is the header row
  return screen.getAllByRole("row").slice(1);
}

describe("BuyerInvoicesPage — Amount and Balance (B1122)", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  it("shows each invoice's real `total` as money in the Amount column, never N/A", async () => {
    respondWith([
      invoiceListItem({ id: "i1", invoiceNumber: "INV-0001", total: 645, balanceDue: 645 }),
      invoiceListItem({
        id: "i2",
        invoiceNumber: "INV-0002",
        status: "PARTIAL",
        total: 1234.5,
        balanceDue: 234.5,
        paidAmount: 1000,
      }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("$645.00");
    expect(cell(rows[1], "Amount")).toBe("$1,234.50");
    expect(screen.queryByText("N/A")).toBeNull();
  });

  it("shows the server-derived `balanceDue` in the Balance column (0 for a settled invoice)", async () => {
    respondWith([
      invoiceListItem({ id: "i1", status: "PARTIAL", total: 120.5, balanceDue: 20.5 }),
      invoiceListItem({ id: "i2", status: "PAID", total: 80, balanceDue: 0, paidAmount: 80 }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Balance")).toBe("$20.50");
    expect(cell(rows[1], "Balance")).toBe("$0.00");
    expect(cell(rows[1], "Amount")).toBe("$80.00");
  });

  it("formats a money column that arrives as a Decimal string (the wire form today)", async () => {
    // Prisma's Decimal serialises as a string until the API serializer lands (DecimalWire).
    respondWith([
      invoiceListItem({
        total: "2500.00" as unknown as number,
        balanceDue: "999.99" as unknown as number,
      }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("$2,500.00");
    expect(cell(rows[0], "Balance")).toBe("$999.99");
  });

  it("shows N/A only when the API really sent no amount", async () => {
    respondWith([
      { ...invoiceListItem(), total: undefined, balanceDue: undefined },
    ] as unknown as BuyerInvoiceListItem[]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("N/A");
    expect(cell(rows[0], "Balance")).toBe("N/A");
  });

  it("row click still opens the invoice", async () => {
    respondWith([invoiceListItem({ id: "i1", invoiceNumber: "INV-0001" })]);
    renderWithProviders(<BuyerInvoicesPage />);
    const number = await screen.findByText("INV-0001");
    number.click();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/invoices/i1"));
  });
});
