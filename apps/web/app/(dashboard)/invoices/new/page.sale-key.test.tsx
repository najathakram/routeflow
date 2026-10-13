import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 485 — the New sale page sends ONE Idempotency-Key per sale attempt and reuses it on any retry of that
 * attempt (a 5xx, a dropped connection, an error that names a committed order or invoice), so the server
 * resumes the stored sale instead of writing a second one. The key is dropped only on a success or a definitive
 * refusal that names no committed sale; a changed cart is a new attempt. Harness copied from
 * page.kept-order.test.tsx.
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

const submit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
};
const callOpts = (n: number) =>
  mockCreateSale.mock.calls[n][1] as {
    onSuccess: (r: unknown) => void;
    onError: (e: unknown) => void;
  };
const keyOf = (n: number) =>
  (mockCreateSale.mock.calls[n][0] as { idempotencyKey?: string }).idempotencyKey;

async function openSaleWithLine() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: /new sale/i }));
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  capturedOnScan!("012345678905");
  await screen.findByDisplayValue("Widget");
  return user;
}

describe("row 485 — the New sale page's Idempotency-Key", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = WIDGET;
    mockApiPost.mockResolvedValue({ data: {} });
  });

  it("the first submit carries a key", async () => {
    const user = await openSaleWithLine();
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
    expect(keyOf(0)).toEqual(expect.stringMatching(/\S{8,}/));
  });

  it.each([
    ["a 5xx", { response: { status: 500, data: { statusCode: 500 } } }],
    ["a dropped connection (no response)", new Error("Network Error")],
    [
      "a kept-order error naming the committed order",
      { response: { status: 500, data: { code: "SALE_INVOICE_CREATE_FAILED", orderId: "ord-1" } } },
    ],
    [
      "a 400 that names the committed invoice",
      { response: { status: 400, data: { message: "x", invoiceId: "inv-1", orderId: "ord-1" } } },
    ],
  ])("Try again after %s sends the SAME key", async (_n, error) => {
    const user = await openSaleWithLine();
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
    expect(keyOf(0)).toBeTruthy();
    act(() => callOpts(0).onError(error));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("after a success, the next sale sends a NEW key", async () => {
    const user = await openSaleWithLine();
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
    act(() => callOpts(0).onSuccess({ id: "inv-1" }));
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("a definitive refusal that names no committed sale clears the key", async () => {
    const user = await openSaleWithLine();
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(1));
    act(() =>
      callOpts(0).onError({ response: { status: 400, data: { message: "Customer not found" } } }),
    );
    await submit(user);
    await waitFor(() => expect(mockCreateSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});
