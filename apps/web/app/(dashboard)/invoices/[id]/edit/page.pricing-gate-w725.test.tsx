import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import EditInvoicePage from "./page";
import { PRICE_LAYER_FAILED_COPY } from "@/components/PriceLayerNotice";

/**
 * S19b slice C, C-2 (SA-811a, SA-813): the invoice EDIT screen prices a product added to the invoice from the customer's LAYER
 * (billing's own resolved row) when flag.units_prices_v2 is on. Flag off: no price-layer request, master's tier price. Layer
 * pending or failed: the prices are unconfirmed (M3 copy) and Save stays disabled. Harness copied from page.scan-level.test.tsx.
 */

const updateMutate = jest.fn();
let mockBarcodeProduct: Record<string, unknown> | undefined;
let capturedOnScan: ((code: string) => void) | undefined;
let flagOn = true;
let layerResponder: () => Promise<unknown> = () => Promise.resolve({ data: {} });

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({
    data: {
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "c1",
      status: "DRAFT",
      issueDate: "2026-09-20T00:00:00.000Z",
      discount: 0,
      shippingFee: 0,
      items: [
        {
          id: "li-1",
          productId: "p0",
          description: "Old",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          taxRate: 0,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateInvoice: () => ({ mutate: updateMutate, mutateAsync: jest.fn(), isPending: false }),
}));
let mockCustomerRead: Record<string, unknown> = {};
const mockRefetchCustomer = jest.fn();
const mockRefetchPrices = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({
    data: { id: "c1", pricingTier: 3 },
    isLoading: false,
    isPending: false,
    isError: false,
    refetch: mockRefetchCustomer,
    ...mockCustomerRead,
  }),
  useCustomerPrices: () => ({ data: [], isLoading: false, refetch: mockRefetchPrices }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
const mockGet = jest.fn((url: string) => {
  if (url === "/customers/c1/price-layer") return layerResponder();
  return url.startsWith("/products/barcode/") && mockBarcodeProduct
    ? Promise.resolve({ data: mockBarcodeProduct })
    : Promise.reject(new Error("not found"));
});
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (url: string) => mockGet(url), post: jest.fn() },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));

/** list $10, tier 3 $8. */
const TIERED = { id: "p-1", name: "Tiered Widget", pricePerUnit: "10", priceTier3: "8" };
const layer = (price: number, aboveList = false) => ({
  data: {
    customerId: "c1",
    complete: true,
    products: {
      "p-1": [{ ref: "pack", label: null, price, listPrice: 10, source: "customer", aboveList }],
    },
  },
});
const layerCalls = () => mockGet.mock.calls.filter((c) => String(c[0]).endsWith("/price-layer"));
const saveBtn = () => screen.getByRole("button", { name: /save changes/i });

async function scanAndSave() {
  renderWithProviders(<EditInvoicePage />);
  await screen.findByDisplayValue("Old");
  await waitFor(() =>
    expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument(),
  );
  await act(async () => {
    capturedOnScan!("111");
  });
  await screen.findByDisplayValue("Tiered Widget");
  await userEvent.click(saveBtn());
  await waitFor(() => expect(updateMutate).toHaveBeenCalled());
  return (updateMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomerRead = {};
  capturedOnScan = undefined;
  mockBarcodeProduct = TIERED;
  flagOn = true;
  layerResponder = () => Promise.resolve(layer(7));
});


/**
 * W-725 (SA-873 follow-up of SA-868/870, the web half): the invoice edit page's pricing gate counted `isLoading` only, so a
 * customer read that FAILED with no data (or was PAUSED offline: TanStack v5 pending, not loading) left the scanner and the
 * product search open and every pick priced at LIST (tier 1). It now uses the one `customerPricingGate`: money fails closed.
 */
describe("W-725: the invoice edit page's picks fail closed on an unread customer price", () => {
  it("a FAILED customer read (no data) closes the scanner with the failed-prices copy (master: a scan adds at list $10)", async () => {
    flagOn = false;
    mockCustomerRead = { data: undefined, isError: true };
    renderWithProviders(<EditInvoicePage />);
    await screen.findByDisplayValue("Old");
    expect(capturedOnScan).toBeUndefined();
    expect(screen.getByTitle(PRICE_LAYER_FAILED_COPY)).toBeInTheDocument();
    // No suggestion can get in, and the stored line is the operator's: Save stays allowed.
    expect(saveBtn()).not.toBeDisabled();
  });

  it("a customer read PAUSED offline (pending, not loading, no data) closes the scanner like a loading one", async () => {
    flagOn = false;
    mockCustomerRead = { data: undefined, isLoading: false, isPending: true };
    renderWithProviders(<EditInvoicePage />);
    await screen.findByDisplayValue("Old");
    expect(capturedOnScan).toBeUndefined();
    expect(screen.getByTitle("Loading customer pricing…")).toBeInTheDocument();
  });

  it("a read error WITH data present (a stale refetch) does not block: a scan prices at the customer's tier ($8)", async () => {
    flagOn = false;
    mockCustomerRead = { isError: true };
    const line = await scanAndSave();
    expect(line).toMatchObject({ unitPrice: 8 });
  });
});
