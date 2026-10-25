import * as React from "react";
import userEvent from "@testing-library/user-event";
import { SALE_RECOVERY_COPY as COPY, saleRecoveryBody } from "@routeflow/types/sale-attempt";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
let mockTenantToday: string | undefined;
jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => mockTenantToday,
}));

import NewInvoicePage from "./page";

/**
 * Row 750 (BT-5): the New sale delivery date defaults to, and is labelled from, the TENANT's day (useTenantToday), not the
 * browser's. Harness copied from page.sale-lock.test.tsx.
 * Row 485 — while a New sale's outcome is UNKNOWN (a 5xx, a dropped connection, or any error naming a committed
 * order or invoice) the cart is LOCKED behind a panel: Try again (the SAME key), Open order / Open invoice (or the
 * recent orders), and Start a new sale behind a confirm. A definitive outcome unlocks as before. The copy is the
 * shared SALE_RECOVERY_COPY, pinned here and in the mobile suite.
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

describe("row 750 — the delivery date follows the tenant's day", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({
      now: new Date("2026-10-25T20:00:00Z"),
      doNotFake: [
        "setTimeout",
        "setInterval",
        "queueMicrotask",
        "nextTick",
        "setImmediate",
        "clearTimeout",
        "clearInterval",
        "clearImmediate",
      ],
    });
    mockCustomers = [];
  });
  afterEach(() => jest.useRealTimers());

  const openSale = async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /new sale/i }));
    return user;
  };
  const dateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;

  it("a tenant already on the 26th (browser still on the 25th) defaults to the 26th and reads 'Delivered today'", async () => {
    mockTenantToday = "2026-10-26";
    await openSale();
    await waitFor(() => expect(dateInput().value).toBe("2026-10-26"));
    expect(screen.getByText(/Delivered today/)).toBeInTheDocument();
  });

  it("the browser's day is a SCHEDULED day for that tenant: picking the 25th reads Delivered, not today", async () => {
    mockTenantToday = "2026-10-26";
    await openSale();
    await waitFor(() => expect(dateInput().value).toBe("2026-10-26"));
    fireEvent.change(dateInput(), { target: { value: "2026-10-25" } });
    expect(screen.getByText(/^Delivered — the order is marked delivered on/)).toBeInTheDocument();
  });

  it("while the zone is unknown the form still works on the browser's day (the server stays the authority)", async () => {
    mockTenantToday = undefined;
    await openSale();
    expect(dateInput().value).toBe("2026-10-25");
  });
});
