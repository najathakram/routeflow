import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * UX audit 2026-11-24, order entry:
 *  F33 closing the price sheet left focus on the page, so the next Tab landed on "Save as draft"
 *  F34 the "Open order exists" prompt never said how old the open order was
 * (The prompt's default button is unchanged: Merge stays the focused primary, N02.)
 * Mocks are the r4-polish harness's.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
let activeOrder: Record<string, unknown> | undefined;
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 3 };

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [cust] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: activeOrder }),
  useCustomerPriceHistory: () => ({ data: undefined }),
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
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => true,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = props.onScan;
    return <button type="button">{props.title}</button>;
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
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
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

const product = (id: string, name: string) => ({
  notFound: false,
  archived: false,
  product: { id, name, pricePerUnit: "10", unit: "each" },
});

async function pickCustomer() {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  await new Promise((r) => setTimeout(r, 50));
}
async function scanLine(code: string, name: string) {
  capturedOnScan!(code);
  await screen.findByText(name);
}

beforeEach(() => {
  jest.clearAllMocks();
  activeOrder = undefined;
  mockResolveProductByCode.mockImplementation(async (code: string) =>
    code === "111" ? product("p1", "Widget") : product("p2", "Gadget"),
  );
});

const rowOf = (name: string) =>
  screen.getAllByRole("listitem").find((li) => within(li).queryByText(name)) as HTMLElement;
const priceOf = (name: string) =>
  rowOf(name).querySelector<HTMLElement>("[data-line-price-trigger]") as HTMLElement;

describe("F33: the price sheet gives focus back to the price that opened it", () => {
  const openSheet = async (name: string) => {
    fireEvent.click(priceOf(name));
    return screen.findByRole("button", { name: "Done" });
  };

  it("Done returns focus to that line's price, not to the page", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await scanLine("222", "Gadget");
    fireEvent.click(await openSheet("Widget"));
    await waitFor(() => expect(priceOf("Widget")).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });

  it("closing by the backdrop does the same, for the line it was opened from", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await scanLine("222", "Gadget");
    await openSheet("Gadget");
    fireEvent.click(screen.getByRole("button", { name: "Close price editor" }));
    await waitFor(() => expect(priceOf("Gadget")).toHaveFocus());
    expect(priceOf("Widget")).not.toHaveFocus();
  });

  it("from the price, Tab goes on inside the same line (never to Save as draft)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    fireEvent.click(await openSheet("Widget"));
    await waitFor(() => expect(priceOf("Widget")).toHaveFocus());
    await user.tab();
    expect(rowOf("Widget")).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("button", { name: /save as draft/i })).not.toHaveFocus();
  });
});

describe("F34: the Open order exists prompt says when the open order was started", () => {
  const openPrompt = async (order: Record<string, unknown>) => {
    activeOrder = order;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    return screen.findByRole("dialog", { name: "Open order exists" });
  };
  const base = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };

  it("shows the day the open order was started", async () => {
    // Noon UTC: the same calendar day in every timezone this suite runs in.
    const prompt = await openPrompt({ ...base, createdAt: "2026-11-17T12:00:00.000Z" });
    expect(within(prompt).getByTestId("merge-open-order-date")).toHaveTextContent(
      "Started Nov 17, 2026",
    );
  });

  it("an open order with no date on it shows no date line (never a dash or 'Invalid Date')", async () => {
    const prompt = await openPrompt(base);
    expect(within(prompt).queryByTestId("merge-open-order-date")).not.toBeInTheDocument();
    expect(within(prompt).queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it("the default is unchanged: Merge is still the focused button (N02)", async () => {
    const prompt = await openPrompt({ ...base, createdAt: "2026-11-17T12:00:00.000Z" });
    await waitFor(() =>
      expect(within(prompt).getByRole("button", { name: /merge into ORD-1/i })).toHaveFocus(),
    );
  });
});
