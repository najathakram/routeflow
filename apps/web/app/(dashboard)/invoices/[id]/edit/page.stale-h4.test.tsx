import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * H4: the edit form sends the `updatedAt` it was seeded from as `expectedUpdatedAt`, and a 409 INVOICE_STALE
 * shows a fixed reload-and-reapply notice beside Save (no toast). A background refetch never moves the token.
 */

let mockInvoice: Record<string, unknown> | undefined;
const updateMutate = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({ mutate: updateMutate, mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: undefined, isLoading: false }),
  useCustomerPrices: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const draft = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items,
  ...extra,
});

const OPENED = "2026-10-13T10:00:00.000Z";

describe("H4 invoice edit stale token", () => {
  beforeEach(() => updateMutate.mockReset());

  it("Save sends the updatedAt the form opened with", async () => {
    mockInvoice = draft(
      [{ id: "li-1", description: "Gum", qty: 1, unitPrice: 2, taxRate: 0, discount: 0 }],
      { updatedAt: OPENED },
    );
    const view = renderWithProviders(<EditInvoicePage />);
    // a background refetch brings a newer row: the token must stay the one the form was seeded from
    mockInvoice = { ...mockInvoice, updatedAt: "2026-10-13T10:05:00.000Z" };
    view.rerender(<EditInvoicePage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /save changes/i }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ id: "inv-1", expectedUpdatedAt: OPENED });
  });

  it("a 409 INVOICE_STALE shows the reload-and-reapply notice beside Save", async () => {
    mockInvoice = draft(
      [{ id: "li-1", description: "Gum", qty: 1, unitPrice: 2, taxRate: 0, discount: 0 }],
      { updatedAt: OPENED },
    );
    updateMutate.mockImplementation((_dto, opts) =>
      opts.onError({ response: { status: 409, data: { code: "INVOICE_STALE" } } }),
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /save changes/i }));
    const notice = await screen.findByTestId("invoice-stale-notice");
    expect(notice).toHaveTextContent(/not saved/);
    expect(notice).toHaveTextContent(/re-apply/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
