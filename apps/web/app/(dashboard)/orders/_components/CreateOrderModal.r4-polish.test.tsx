import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Orders apple-ux r4 gap-closer (PR-F), Create Order dialog:
 *  Q08 one compact footer row (Minimize lives in the header beside the X; no second "Close")
 *  Q09 "Tap to change" on the active line only
 *  N02 the "Open order exists" prompt: Enter takes the primary action, Escape cancels, Tab reaches the other
 * Pixels (390/768/1440) are the UI proof; this pins the DOM contract.
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

describe("Q08: one compact footer row; Minimize beside the header X", () => {
  it("has exactly one Close control (the header X) and Minimize lives in the header with it", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    const closes = within(dialog).getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(1);
    const minimize = within(dialog).getByRole("button", { name: /minimize/i });
    expect(minimize.parentElement).toBe(closes[0].parentElement);
  });

  it("the footer is a single row at every width: no stacked column, just the save actions (and the total)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    const footer = screen.getByTestId("create-order-footer");
    expect(footer.className).not.toMatch(/flex-col/);
    expect(footer).toContainElement(screen.getByTestId("create-order-footer-total"));
    expect(footer).toContainElement(screen.getByRole("button", { name: /save as draft/i }));
    expect(footer).toContainElement(screen.getByRole("button", { name: /^create order$/i }));
    // Create Order stays the one primary: nothing else in the footer dismisses or parks
    expect(within(footer).queryByRole("button", { name: /minimize|close/i })).toBeNull();
  });

  it("the header X closes the dialog (it replaced the footer Close, same dismiss)", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Minimize is disabled while the builder is empty and enabled once there is something to park", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: /minimize/i })).toBeDisabled();
    await pickCustomer();
    expect(screen.getByRole("button", { name: /minimize/i })).toBeEnabled();
  });

  // r5 row 730: items-center / justify-center only act on a flex box; the X (an inline Dialog.Close) was not one.
  it("the X is a flex box below lg, so its centring classes take effect", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "max-lg:flex",
      "max-lg:items-center",
      "max-lg:justify-center",
    );
  });

  it("Minimize is a 44 px target below lg like the X beside it", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    for (const name of [/minimize/i, "Close"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("max-lg:h-11", "max-lg:w-11");
    }
  });
});

describe("Q09: 'Tap to change' shows on one line only", () => {
  it("two lines show the hint once, on the line you last touched", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await scanLine("222", "Gadget");
    const rows = screen
      .getAllByRole("listitem")
      .filter((li) => within(li).queryByLabelText("Quantity"));
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText("Tap to change")).toHaveLength(1);
    // the newest line is the active one
    expect(within(rows[1]).getByText("Tap to change")).toBeInTheDocument();
    await user.click(within(rows[0]).getByLabelText("Quantity"));
    expect(screen.getAllByText("Tap to change")).toHaveLength(1);
    expect(within(rows[0]).getByText("Tap to change")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Tap to change")).not.toBeInTheDocument();
  });
});

describe("N02: the Open order exists prompt is keyboard-first", () => {
  const openPrompt = async () => {
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    return screen.findByRole("dialog", { name: "Open order exists" });
  };

  it("opens with the primary action (Merge) focused, so Enter merges", async () => {
    const user = userEvent.setup();
    const prompt = await openPrompt();
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "merge" });
  });

  it("Tab reaches Create as separate and Enter chooses it", async () => {
    const user = userEvent.setup();
    const prompt = await openPrompt();
    const merge = within(prompt).getByRole("button", { name: /merge into ORD-1/i });
    await waitFor(() => expect(merge).toHaveFocus());
    await user.tab();
    expect(within(prompt).getByRole("button", { name: /create as separate/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).toMatchObject({ mergeChoice: "separate" });
  });

  it("Escape cancels the prompt and creates nothing", async () => {
    const user = userEvent.setup();
    await openPrompt();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open order exists" })).not.toBeInTheDocument(),
    );
    expect(createOrderMutate).not.toHaveBeenCalled();
  });
});

describe("N01: merging tells the operator what the merge added", () => {
  it("the merged toast names the added line and the total the SERVER returned", async () => {
    const user = userEvent.setup();
    createOrderMutate.mockImplementation((_payload, opts) =>
      opts.onSuccess({ id: "o1", orderNumber: "ORD-1", total: "131.94" }),
    );
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await scanLine("111", "Widget");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const merge = await screen.findByRole("button", { name: /merge into ORD-1/i });
    await user.click(merge);
    expect(await screen.findByText("Merged into order ORD-1")).toBeInTheDocument();
    expect(screen.getByText("+1 Widget · new total $131.94")).toBeInTheDocument();
  });
});
