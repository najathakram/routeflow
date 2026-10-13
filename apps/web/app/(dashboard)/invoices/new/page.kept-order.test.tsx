import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 466 (sale path) — createSale commits the ORDER, then builds its invoice. When the invoice step
 * fails the API body carries `orderId`; the page must open that order (fixed copy, never the server's
 * message) and must not offer a second sale, which would duplicate it. An invoiceId, when present,
 * wins (the invoice exists). Harness copied from page.kept-draft.test.tsx.
 */

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
const mockCreateSale = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockApiPost = jest.fn();
const mockApiGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
const createInvoiceMutateAsync = jest.fn();
const updateInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({
    mutate: createInvoiceMutate,
    mutateAsync: createInvoiceMutateAsync,
    isPending: false,
  }),
  useUpdateInvoice: () => ({
    mutate: updateInvoiceMutate,
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: mockCreateSale, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));

jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockApiGet(url),
    post: (...args: unknown[]) => mockApiPost(...args),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const WIDGET = { id: "prod-1", name: "Widget", pricePerUnit: "9.99" };
/** An axios-shaped error: any code (or none), the committed draft's id in the body. */
const sendFailure = (data: Record<string, unknown>) => ({ response: { status: 400, data } });

const KEPT_ORDER_TITLE = "Sale recorded, invoice not created";

async function openNewSaleWithLine() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: /new sale/i }));
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  await user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
  await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
  return (mockCreateSale.mock.calls[0][1] as { onError: (e: unknown) => void }).onError;
}

describe("row 466 — the New sale path opens the kept order when the invoice step fails", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = WIDGET;
    mockApiPost.mockResolvedValue({ data: {} });
  });

  it.each([
    ["a coded 500", { code: "SALE_INVOICE_CREATE_FAILED", orderId: "ord-1" }],
    [
      "a plain 400 with a raw message",
      { statusCode: 400, message: "raw server words", orderId: "ord-1" },
    ],
  ])("%s with orderId -> opens /orders/:id, fixed copy, one sale", async (_n, body) => {
    const onError = await openNewSaleWithLine();
    onError(sendFailure(body));

    expect(mockPush).toHaveBeenCalledWith("/orders/ord-1");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: KEPT_ORDER_TITLE, variant: "warning" }),
    );
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain("raw server words");
    expect(mockCreateSale).toHaveBeenCalledTimes(1);
  });

  it("an error with BOTH ids opens the invoice, not the order", async () => {
    const onError = await openNewSaleWithLine();
    onError(sendFailure({ invoiceId: "inv-1", orderId: "ord-1" }));
    expect(mockPush).toHaveBeenCalledWith("/invoices/inv-1");
    expect(mockPush).not.toHaveBeenCalledWith("/orders/ord-1");
  });

  it("control: an error with neither id stays on the form with the create-failed toast", async () => {
    const onError = await openNewSaleWithLine();
    onError(sendFailure({ statusCode: 400, message: "Customer not found" }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not create the sale", variant: "error" }),
    );
  });
});
