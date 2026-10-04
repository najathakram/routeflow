import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * "Bill an existing order" -> "Choose items..." opens the SAME SplitInvoiceModal the order page
 * does. This second caller used to pass no subtotal / boxes / unitsPerBox, so one box of 24 at
 * $12.90 previewed $309.60 (qty x BOX price) while the server bills $12.90 (B1001). Both callers now
 * go through the one order-line -> modal-line mapper. Harness copied from page.special-override.test.tsx.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
let mockOrders: Array<Record<string, unknown>> = [];
const mockCreateSale = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

// Keyed by URL so the page's own /settings fetch (tax rate, on mount) doesn't consume the
// barcode-scan mock — apiClient.get is called for both.
let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockProductsGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  return Promise.resolve({ data: {} });
});
let mockSearchProducts: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSearchProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: createInvoiceMutate, isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: mockCreateSale, isPending: false }),
  useUninvoicedOrders: () => ({ orders: mockOrders, isLoading: false }),
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
    get: (url: string) => mockProductsGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Same technique as CreateOrderModal.test.tsx (B499): the real scanner needs getUserMedia,
// impractical in JSDOM — capture the live onScan prop so a test can trigger it directly.
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));

// Same technique — the real modal needs form interaction impractical to drive here; capture
// onCreated so a test can simulate "the operator just created this product" directly (#1176 pin).
let capturedOnCreated: ((product: Record<string, unknown>) => void) | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: {
    isOpen: boolean;
    onCreated: (product: Record<string, unknown>) => void;
  }) => {
    if (props.isOpen) capturedOnCreated = props.onCreated;
    return null;
  },
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

function order(line: Record<string, unknown>) {
  return {
    id: "ord-1",
    orderNumber: "ORD-0001",
    customerId: "cust-1",
    status: "PENDING",
    total: 12.9,
    lineItems: [
      {
        id: "li-1",
        product: { id: "p1", name: "Case of widgets", unit: "pc" },
        invoicedQty: 0,
        ...line,
      },
    ],
  };
}

async function openSplitModal() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(screen.getByRole("button", { name: /bill an existing order/i }));
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  await user.click(await screen.findByRole("button", { name: /choose items/i }));
}

describe("invoices/new — Bill an existing order -> split modal preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 1 }];
  });

  it("one box of 24 @ $12.90 (stored subtotal $12.90) previews $12.90, never $309.60", async () => {
    mockOrders = [
      order({ qty: 24, unitPrice: 12.9, subtotal: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 }),
    ];
    await openSplitModal();
    expect(screen.getAllByText("$12.90").length).toBeGreaterThan(0);
    expect(screen.queryByText("$309.60")).not.toBeInTheDocument();
  });

  it("the same boxed line with no stored subtotal still previews $12.90", async () => {
    mockOrders = [order({ qty: 24, unitPrice: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 })];
    await openSplitModal();
    expect(screen.getAllByText("$12.90").length).toBeGreaterThan(0);
    expect(screen.queryByText("$309.60")).not.toBeInTheDocument();
  });
});
