import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * #2791 (ruled): a pending-mirror DRAFT (order-linked, order not yet delivered) is refused by the API by
 * design — the order is the source of truth until delivery. The detail page hides Edit for it; the edit
 * route must apply the SAME predicate and send the user to the order edit page with a one-line reason,
 * never render an editable form whose save can only fail.
 */

const replace = jest.fn();
const toastMock = jest.fn();
const updateMutate = jest.fn();
let mockInvoice: Record<string, unknown> | undefined;

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: toastMock }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace, back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({ mutate: updateMutate, mutateAsync: updateMutate, isPending: false }),
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

const base = {
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  orderId: "ord-9",
  order: { status: "PENDING", orderNumber: "1042" },
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items: [
    {
      id: "li-1",
      productId: "p1",
      description: "Widget",
      qty: 2,
      boxes: 0,
      pieces: 2,
      unitsPerBox: 1,
      unitPrice: 5,
      subtotal: 10,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("invoice edit page — pending-mirror draft (#2791)", () => {
  it("redirects to the order edit page and explains why; no form, no save", () => {
    mockInvoice = base;
    renderWithProviders(<EditInvoicePage />);

    expect(replace).toHaveBeenCalledWith("/orders/ord-9");
    expect(screen.getByText(/mirrors order #1042/i)).toBeInTheDocument();
    expect(screen.getByText(/edit the order instead/i)).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This invoice mirrors order 1042", duration: 8000 }),
    );
    expect(replace.mock.invocationCallOrder[0]).toBeGreaterThan(
      toastMock.mock.invocationCallOrder[0],
    );
    expect(screen.getByRole("link", { name: /open order #1042/i })).toHaveAttribute(
      "href",
      "/orders/ord-9",
    );
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it.each(["DELIVERED", "PARTIALLY_DELIVERED"])(
    "does NOT redirect once the order is %s (edit form as before)",
    (orderStatus) => {
      mockInvoice = { ...base, order: { status: orderStatus, orderNumber: "1042" } };
      renderWithProviders(<EditInvoicePage />);
      expect(replace).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    },
  );

  it("does NOT redirect a batch-linked draft", () => {
    mockInvoice = { ...base, deliveryBatchId: "b1" };
    renderWithProviders(<EditInvoicePage />);
    expect(replace).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does NOT redirect a manual (orderId null) draft", () => {
    mockInvoice = { ...base, orderId: null, order: undefined };
    renderWithProviders(<EditInvoicePage />);
    expect(replace).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });
});
