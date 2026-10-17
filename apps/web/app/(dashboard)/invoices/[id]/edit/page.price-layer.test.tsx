import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import EditInvoicePage from "./page";

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
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: { id: "c1", pricingTier: 3 }, isLoading: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false }),
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
  capturedOnScan = undefined;
  mockBarcodeProduct = TIERED;
  flagOn = true;
  layerResponder = () => Promise.resolve(layer(7));
});

describe("S19b C-2: invoice edit adds from the customer layer", () => {
  it("C-2: a scanned add lands on the layer price $7, not the tier $8", async () => {
    expect(await scanAndSave()).toMatchObject({ productId: "p-1", unitPrice: 7 });
  });

  it("R2: an above-list layer price ($12 on a $10 list) is added as is", async () => {
    layerResponder = () => Promise.resolve(layer(12, true));
    expect(await scanAndSave()).toMatchObject({ unitPrice: 12 });
  });

  it("flag OFF: no price-layer request and master's tier price ($8)", async () => {
    flagOn = false;
    expect(await scanAndSave()).toMatchObject({ unitPrice: 8 });
    expect(layerCalls()).toHaveLength(0);
  });

  it("M3: while the layer is pending the prices are unconfirmed and Save is disabled", async () => {
    layerResponder = () => new Promise(() => {});
    renderWithProviders(<EditInvoicePage />);
    expect(await screen.findByText("Checking this customer's prices\u2026")).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
  });

  it("a failed layer read stops the Loading customer pricing spinner copy (it is a failure, not a wait)", async () => {
    layerResponder = () => Promise.reject(new Error("boom"));
    renderWithProviders(<EditInvoicePage />);
    expect(
      await screen.findByPlaceholderText(/couldn't load this customer's prices/i),
    ).toBeDisabled();
    expect(screen.queryByPlaceholderText(/loading customer pricing/i)).not.toBeInTheDocument();
  });

  it("M3: a failed layer read says so with Retry and keeps Save disabled", async () => {
    layerResponder = () => Promise.reject(new Error("boom"));
    renderWithProviders(<EditInvoicePage />);
    expect(await screen.findByText(/couldn't load this customer's prices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
  });
});
