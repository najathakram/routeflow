import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * New invoice builder: a line discount above its line total is refused before submit with a fixed
 * message. The server stores roundMoney(line - discount) and rejects a negative line, so the form
 * must never offer a total (or a save) the saved invoice cannot have. Harness copied from page.test.tsx.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
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
  useCreateSale: () => ({ mutate: jest.fn(), isPending: false }),
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

async function openStandaloneBuilder() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  // Pick a customer — validate() requires one before Save as Draft will submit.
  const customerInput = screen.getByPlaceholderText(/search customers/i);
  await user.click(customerInput);
  await user.click(await screen.findByText("Acme Co"));
  return user;
}

describe("new invoice — a line discount above its line total", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockSearchProducts = [];
  });

  it("is refused with a fixed message and nothing is sent", async () => {
    mockBarcodeProduct = { id: "prod-1", name: "Gum", pricePerUnit: "5" };
    const user = await openStandaloneBuilder();
    capturedOnScan!("012345678905");
    await screen.findByDisplayValue("Gum");

    await user.type(screen.getByLabelText("Line discount"), "50");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));

    expect(
      await screen.findByText("Line discount cannot exceed the line total."),
    ).toBeInTheDocument();
    expect(createInvoiceMutate).not.toHaveBeenCalled();
  });

  it("control: a discount within the line saves", async () => {
    mockBarcodeProduct = { id: "prod-1", name: "Gum", pricePerUnit: "5" };
    const user = await openStandaloneBuilder();
    capturedOnScan!("012345678905");
    await screen.findByDisplayValue("Gum");

    await user.type(screen.getByLabelText("Line discount"), "2");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));

    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(screen.queryByText("Line discount cannot exceed the line total.")).toBeNull();
  });
});
