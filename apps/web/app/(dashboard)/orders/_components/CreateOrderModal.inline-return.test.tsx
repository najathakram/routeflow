import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// #2406 — CreateOrderModal host: the Returns section, and the returnKey/refusal lifecycle
// around a create-order save that carries an inline return. Modeled on CreateOrderModal.test.tsx
// (same mock set) and RecordInlineReturnDialog.test.tsx (the InlineReturnSection mocks).
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  // Backs BOTH the modal's own product search (unused by these tests) and
  // InlineReturnSection's "Add another product" search.
  useProducts: () => ({
    data: { data: [{ id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null }] },
  }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
  // InlineReturnSection's own entryOrderId hydration — CreateOrderModal never passes one, so
  // this is always called with "".
  useOrder: () => ({ data: undefined }),
}));
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
let hasInlineReturns = true;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => hasInlineReturns }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { title?: string }) => (
    <button type="button" aria-label={props.title}>
      {props.title}
    </button>
  ),
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => false,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: () => ({
    videoRef: { current: null },
    torchAvailable: false,
    torchOn: false,
    toggleTorch: jest.fn(),
    refocus: jest.fn(),
    error: null,
  }),
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };

async function pickCustomer() {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
}

async function openReturnsAndAddLine(pieces: string) {
  fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByText("Widget"));
  fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: pieces } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomers = [acme];
  hasInlineReturns = true;
});

describe("CreateOrderModal — Returns section gate (#2406)", () => {
  it("addon off ⇒ no Returns section", async () => {
    hasInlineReturns = false;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.queryByRole("button", { name: /^returns$/i })).not.toBeInTheDocument();
  });

  it("addon on ⇒ collapsed Returns section is available for the selected customer", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.getByRole("button", { name: /^returns$/i })).toBeInTheDocument();
  });
});

describe("CreateOrderModal — inline return payload on save (#2406)", () => {
  it("a quoted return is carried as inlineReturn with items + returnKey and WITHOUT customerId/orderId", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    quoteMutate.mock.calls[0][1].onSuccess({
      chunks: [],
      subtotal: 0,
      taxAmount: 0,
      categoryTax: 0,
      total: 0,
      productBreakdown: {},
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    const dto = createOrderMutate.mock.calls[0][0];
    expect(dto.inlineReturn).toBeDefined();
    expect(dto.inlineReturn.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }]);
    expect(dto.inlineReturn.reason).toBe("DAMAGED");
    expect(typeof dto.inlineReturn.returnKey).toBe("string");
    expect(dto.inlineReturn.returnKey.length).toBeGreaterThan(0);
    expect(dto.inlineReturn).not.toHaveProperty("customerId");
    expect(dto.inlineReturn).not.toHaveProperty("orderId");
  });

  it("a retry after a network error resends the SAME returnKey", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    quoteMutate.mock.calls[0][1].onSuccess({
      chunks: [],
      subtotal: 0,
      taxAmount: 0,
      categoryTax: 0,
      total: 0,
      productBreakdown: {},
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const firstKey = createOrderMutate.mock.calls[0][0].inlineReturn.returnKey;

    // A network failure (5xx / no clean business refusal) is a RETRY of the same attempt —
    // never a 4xx, so no fresh key is minted (mirrors the standalone dialog's own AC4: only
    // an actual server REFUSAL, a 4xx, starts a new attempt).
    createOrderMutate.mock.calls[0][1].onError({
      response: { status: 500, data: { message: "Network error" } },
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(2);
    const secondKey = createOrderMutate.mock.calls[1][0].inlineReturn.returnKey;
    expect(secondKey).toBe(firstKey);
  });

  it("after a 4xx refusal, the next submit mints a NEW returnKey", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    quoteMutate.mock.calls[0][1].onSuccess({
      chunks: [],
      subtotal: 0,
      taxAmount: 0,
      categoryTax: 0,
      total: 0,
      productBreakdown: {},
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const firstKey = createOrderMutate.mock.calls[0][0].inlineReturn.returnKey;
    createOrderMutate.mock.calls[0][1].onError({
      response: { status: 409, data: { message: "returnKey already used" } },
    });
    await screen.findByText("returnKey already used");

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const secondKey = createOrderMutate.mock.calls[1][0].inlineReturn.returnKey;
    expect(secondKey).not.toBe(firstKey);
  });
});
