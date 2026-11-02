import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * SA-1086 (LS-2, LS-4, LS-7) on the real New Order screen: the quiet line under each row shows what is left
 * in the line's own words, the order goes past it with a note, and Create Order is NEVER disabled by it
 * (the server's coded refusal stays the only stop).
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};
const BOXED = {
  id: "p-boxed",
  name: "Sample Chips",
  sku: "400500600",
  unit: "case",
  pricePerUnit: "30.00",
  unitsPerBox: 12,
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN, BOXED] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
}

/** The stock endpoint answers `stock`; every other GET (tax rate and the like) answers as before. */
const serve = (stock: unknown | (() => Promise<never>)) =>
  mockGet.mockImplementation((url: string) => {
    if (url === "/orders/stock-availability") {
      return typeof stock === "function"
        ? (stock as () => Promise<never>)()
        : Promise.resolve({ data: stock });
    }
    return Promise.resolve({ data: { taxRate: 0 } });
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CreateOrderModal live stock per line", () => {
  it("LS-2: a boxed line over stock reads in the product's pack word and pieces, with the backorder note", async () => {
    serve({
      allowOversell: true,
      items: [{ productId: "p-boxed", availablePieces: 20 }],
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Chips");
    await pick("Sample Chips"); // a repeat pick adds a whole case: 2 boxes = 24 pieces
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-state")).toBe("ready"),
    );
    const note = screen.getByTestId("line-stock");
    expect(note.getAttribute("data-level")).toBe("low");
    expect(note.textContent).toContain("1 case and 8 pieces left"); // the product's own pack word
    expect(screen.getByTestId("line-stock-message").textContent).toMatch(/backorder/i);
    expect(mockGet).toHaveBeenCalledWith(
      "/orders/stock-availability",
      expect.objectContaining({
        params: expect.objectContaining({ productIds: "p-boxed", mode: "entry" }),
      }),
    );
  });

  it("LS-4: over stock with oversell off shows the note and leaves Create Order enabled", async () => {
    serve({ allowOversell: false, items: [{ productId: "p-plain", availablePieces: 0 }] });
    const { unmount } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    const message = await screen.findByTestId("line-stock-message");
    expect(message.textContent).toMatch(/none left/i);
    expect(message.textContent).toMatch(/won't save/i);
    // The note never decides: the button reads exactly as it does for an order that is within stock.
    const refused = (screen.getByRole("button", { name: /create order/i }) as HTMLButtonElement)
      .disabled;
    unmount();
    serve({ allowOversell: true, items: [{ productId: "p-plain", availablePieces: 40 }] });
    const again = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("ok"),
    );
    const within = (screen.getByRole("button", { name: /create order/i }) as HTMLButtonElement)
      .disabled;
    expect(refused).toBe(within);
    again.unmount();
  });

  it("an order within stock shows the count and no warning", async () => {
    serve({ allowOversell: true, items: [{ productId: "p-plain", availablePieces: 40 }] });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("ok"),
    );
    expect(screen.getByTestId("line-stock").textContent).toContain("40");
    expect(screen.queryByTestId("line-stock-message")).not.toBeInTheDocument();
  });

  it("LS-7: a failed read shows no note, no 0, and the screen carries on", async () => {
    serve(() => Promise.reject(new Error("boom")));
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith("/orders/stock-availability", expect.anything()),
    );
    await waitFor(() => expect(screen.queryByTestId("line-stock")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /create order/i })).toBeInTheDocument();
  });

  it("LS-7: a product the server leaves out (a recipe, or not this tenant's) shows no note", async () => {
    serve({ allowOversell: true, items: [] });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith("/orders/stock-availability", expect.anything()),
    );
    await waitFor(() => expect(screen.queryByTestId("line-stock")).not.toBeInTheDocument());
  });
});
