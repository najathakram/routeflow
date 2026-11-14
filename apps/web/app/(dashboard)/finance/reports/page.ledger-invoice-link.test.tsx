import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * UX guide B13: a Ledger row is an invoice. Its number column shows the invoice number (never the order number
 * under an "Invoice #" header) and links to the invoice page, which has the tenant's branding and payments.
 */
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("report=ledger"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn((url: string) =>
      Promise.resolve({
        data:
          url === "/bookkeeping/transactions"
            ? {
                data: [
                  {
                    id: "inv-1",
                    invoiceNumber: "INV-0042",
                    customerId: "c-1",
                    customer: { id: "c-1", businessName: "Acme Foods" },
                    order: { id: "o-1", orderNumber: "ORD-00001" },
                    status: "UNPAID",
                    totalOwed: 30,
                    totalPaid: 0,
                    createdAt: "2026-10-01T00:00:00.000Z",
                  },
                  {
                    id: "inv-2",
                    invoiceNumber: "INV-0043",
                    customerId: "c-1",
                    customer: { id: "c-1", businessName: "Acme Foods" },
                    order: null,
                    status: "PAID",
                    totalOwed: 10,
                    totalPaid: 10,
                    createdAt: "2026-10-02T00:00:00.000Z",
                  },
                ],
                meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
              }
            : [],
      }),
    ),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("finance/reports Ledger: the number is the invoice number and opens the invoice (UX guide B13)", () => {
  it("links each row's number to /invoices/<id> and shows invoiceNumber, not the order number", async () => {
    renderWithProviders(<FinanceReportsPage />);
    const link = await screen.findByRole("link", { name: "INV-0042" });
    expect(link).toHaveAttribute("href", "/invoices/inv-1");
    expect(screen.getByRole("link", { name: "INV-0043" })).toHaveAttribute(
      "href",
      "/invoices/inv-2",
    );
    expect(screen.queryByText("ORD-00001")).toBeNull();
  });
});
