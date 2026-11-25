import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
let mockTenantToday: string | undefined;
jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => mockTenantToday,
}));

import NewInvoicePage from "./page";

/**
 * BF-9 (SA-1211): the sale summary's "Total quantity" is 0 until a line exists; the seeded blank row is not a line.
 * Harness copied from page.sale-date-chip.test.tsx.
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

describe("BF-9: Total quantity with no lines", () => {
  it("reads 0 on a fresh New sale, not the blank row's seeded 1", async () => {
    mockCustomers = [];
    mockTenantToday = "2026-10-26";
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    const dt = await screen.findByText("Total quantity");
    expect(dt.parentElement).toHaveTextContent(/^Total quantity0$/);
  });

  const openSale = async () => {
    mockCustomers = [];
    mockTenantToday = "2026-10-26";
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    await screen.findByText("Total quantity");
    return user;
  };
  const totalQuantity = () => screen.getByText("Total quantity").parentElement;

  it("a row with only a description counts: qty 3 reads 3", async () => {
    const user = await openSale();
    await user.type(screen.getByPlaceholderText("Description / product…"), "Widget");
    const qty = screen.getByLabelText("Qty");
    await user.clear(qty);
    await user.type(qty, "3");
    expect(totalQuantity()).toHaveTextContent(/^Total quantity3$/);
  });

  it("a row with only a price above 0 counts: qty 1 reads 1", async () => {
    const user = await openSale();
    await user.type(screen.getByLabelText("Unit price"), "5");
    expect(totalQuantity()).toHaveTextContent(/^Total quantity1$/);
  });

  it("a row with only a product (no description, price 0) counts: reads 1", async () => {
    await openSale();
    mockBarcodeProduct = { id: "prod-1", name: "", pricePerUnit: "0" };
    capturedOnScan!("012345678905");
    await waitFor(() => expect(totalQuantity()).toHaveTextContent(/^Total quantity1$/));
  });
});
