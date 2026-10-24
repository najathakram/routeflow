import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 466 ("the record lies") — create-and-send commits the draft first and sends after. When the
 * send step fails with ANY error, the API body carries the committed draft's `invoiceId`; the page
 * must open that draft (fixed copy, never the server's message) and must not offer a second create,
 * which would duplicate the invoice. Harness copied from page.special-override.test.tsx.
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
const KEPT_TITLE = "Saved as a draft, not sent";

async function openStandaloneWithLine() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  return user;
}

describe("row 466 — create-and-send opens the kept draft on ANY send failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = WIDGET;
    mockApiPost.mockResolvedValue({ data: {} });
  });

  it.each([
    [
      "a plain 400 (send refusal)",
      { statusCode: 400, message: "raw server words", invoiceId: "inv-kept" },
    ],
    ["a 409", { code: "INVOICE_CHANGED_CONCURRENTLY", message: "raw", invoiceId: "inv-kept" }],
    [
      "INVOICE_SEND_AFTER_CREATE_FAILED",
      { code: "INVOICE_SEND_AFTER_CREATE_FAILED", invoiceId: "inv-kept" },
    ],
    ["EMAIL_SEND_FAILED", { code: "EMAIL_SEND_FAILED", message: "smtp", invoiceId: "inv-kept" }],
  ])("Save and Send + %s -> opens the draft, one create, fixed copy", async (_n, body) => {
    const user = await openStandaloneWithLine();
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalledTimes(1));
    expect(createInvoiceMutate.mock.calls[0][0]).toMatchObject({ send: true });

    const opts = createInvoiceMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    opts.onError(sendFailure(body));

    expect(mockPush).toHaveBeenCalledWith("/invoices/inv-kept");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: KEPT_TITLE, variant: "warning" }),
    );
    // The server's words never reach the screen (B980).
    expect(JSON.stringify(mockToast.mock.calls)).not.toMatch(/raw server words|"raw"|smtp/);
    // The page offers no way to create again: still exactly one create call.
    expect(createInvoiceMutate).toHaveBeenCalledTimes(1);
  });

  it("control: a create failure with NO invoiceId stays on the form with the create-failed toast", async () => {
    const user = await openStandaloneWithLine();
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    const opts = createInvoiceMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    opts.onError(sendFailure({ statusCode: 400, message: "Customer not found" }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to create invoice", variant: "error" }),
    );
  });

  it("a preview draft whose send fails is NOT reported as sent; the draft opens with the kept copy", async () => {
    createInvoiceMutateAsync.mockResolvedValue({ id: "draft-9" });
    updateInvoiceMutate.mockImplementation((_dto, opts: { onSuccess: () => Promise<void> }) =>
      opts.onSuccess(),
    );
    const user = await openStandaloneWithLine();
    // Download saves the draft first (the pdf meta has no url, so it then toasts a failure).
    await user.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => expect(createInvoiceMutateAsync).toHaveBeenCalled());
    mockApiPost.mockRejectedValue(sendFailure({ statusCode: 400, message: "boom" }));
    mockToast.mockClear();

    await user.click(screen.getByRole("button", { name: /save and send/i }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/invoices/draft-9"));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: KEPT_TITLE }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Invoice sent" }));
    expect(createInvoiceMutate).not.toHaveBeenCalled();
  });
});
