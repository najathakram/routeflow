import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * An item that is not listed can be created from the order builder, typed or scanned (owner bug: "if the product is not
 * listed, we should be able to add a new product from then and there"). The typed row and the scan miss already open the
 * New product window and Save puts the item on the order, and nothing pinned any of it (every other file in this
 * folder stubs the window to null). What was wrong: Enter on typed WORDS that match nothing sent the words to the SKU
 * field and left Name empty, so the item was saved with its name as its code.
 *
 * The window is stubbed: its fields and its own save are `InlineCreateProductModal`'s tests. What is pinned here is
 * what the order hands it and what it does with the product that comes back.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const LISTED = {
  id: "p-listed",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};
const CREATED = {
  id: "p-created",
  name: "Oat Latte",
  sku: "OAT-1",
  unit: "case",
  pricePerUnit: "12.50",
  unitsPerBox: null,
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  // the search matches by name, so "Oat Latte" matches nothing and "Cola" matches the one listed product
  useProducts: (params: { search?: string }) => ({
    data: { data: params?.search && /cola/i.test(params.search) ? [LISTED] : [] },
  }),
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
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

let capturedOnScan: ((code: string, source?: "field") => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string, source?: "field") => void }) => {
    capturedOnScan = props.onScan;
    return <button type="button">scan</button>;
  },
}));

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

// The window, stubbed: it shows what it was opened with and saves a fixed product.
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: any) => {
    if (!props.isOpen) return null;
    return (
      <div role="dialog" aria-label="New product">
        <span data-testid="window-name">{props.initialName ?? ""}</span>
        <span data-testid="window-sku">{props.initialSku ?? ""}</span>
        <button type="button" onClick={() => props.onCreated(CREATED)}>
          Save new product
        </button>
        <button type="button" onClick={props.onClose}>
          Close new product
        </button>
      </div>
    );
  },
}));

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
const windowOpen = () => screen.queryByRole("dialog", { name: "New product" });
const typeInto = (value: string) => fireEvent.change(search(), { target: { value } });

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = undefined;
  mockResolveProductByCode.mockResolvedValue({ notFound: true });
});

describe("typed text that matches nothing (Create Order)", () => {
  it("B1: the list says so and ends in 'Create new product' with the typed text", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto("Oat Latte");
    expect(await screen.findByText("No products found.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Create new product/ })).toHaveTextContent(
      'Create new product: "Oat Latte"',
    );
  });

  it("B1: the row opens the window with the words in Name and nothing in SKU", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto("Oat Latte");
    fireEvent.click(await screen.findByRole("option", { name: /Create new product/ }));
    expect(screen.getByTestId("window-name")).toHaveTextContent("Oat Latte");
    expect(screen.getByTestId("window-sku")).toBeEmptyDOMElement();
  });

  it("B2: Save puts the new product on the order, with its own price and unit, and clears the search", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto("Oat Latte");
    fireEvent.click(await screen.findByRole("option", { name: /Create new product/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save new product" }));
    await waitFor(() => expect(screen.getByTitle("Remove")).toBeInTheDocument());
    expect(windowOpen()).toBeNull();
    const line = screen.getByTitle("Remove").closest("li") as HTMLElement;
    expect(line).toHaveTextContent("Oat Latte");
    expect(line).toHaveTextContent("$12.50 / case");
    expect(search()).toHaveValue("");
  });

  it("B2: Close leaves the order empty", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto("Oat Latte");
    fireEvent.click(await screen.findByRole("option", { name: /Create new product/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close new product" }));
    expect(windowOpen()).toBeNull();
    expect(screen.queryByTitle("Remove")).toBeNull();
  });
});

describe("typed text that matches something (Create Order)", () => {
  it("B6: the match is listed and 'Create new product' still follows it", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto("Cola");
    const rows = await screen.findAllByRole("option");
    expect(rows[0]).toHaveTextContent("Sample Cola");
    expect(rows[rows.length - 1]).toHaveTextContent('Create new product: "Cola"');
  });
});

describe("Enter in the box with nothing found (Create Order)", () => {
  async function enter(text: string) {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    typeInto(text);
    await act(async () => {
      fireEvent.keyDown(search(), { key: "Enter" });
    });
    await waitFor(() => expect(windowOpen()).not.toBeNull());
  }

  it("B3: words go to Name, not to SKU", async () => {
    await enter("Oat Latte");
    expect(screen.getByTestId("window-name")).toHaveTextContent("Oat Latte");
    expect(screen.getByTestId("window-sku")).toBeEmptyDOMElement();
  });

  it("B4: a code with a digit and no space goes to SKU, so the next scan finds the item", async () => {
    await enter("AB12345");
    expect(screen.getByTestId("window-sku")).toHaveTextContent("AB12345");
    expect(screen.getByTestId("window-name")).toBeEmptyDOMElement();
  });
});

describe("a scan that finds nothing (Create Order)", () => {
  it("B5: a camera read goes to SKU whatever its characters", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => {
      capturedOnScan?.("ABCDEFGH");
    });
    await waitFor(() => expect(windowOpen()).not.toBeNull());
    expect(screen.getByTestId("window-sku")).toHaveTextContent("ABCDEFGH");
    expect(screen.getByTestId("window-name")).toBeEmptyDOMElement();
  });

  it("B5: a wedge read of a code goes to SKU", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => {
      capturedOnScan?.("0123456789012", "field");
    });
    await waitFor(() => expect(windowOpen()).not.toBeNull());
    expect(screen.getByTestId("window-sku")).toHaveTextContent("0123456789012");
  });

  it("B7: a failed lookup opens no window (a network error is not 'the item does not exist')", async () => {
    mockResolveProductByCode.mockRejectedValue(new Error("network"));
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => {
      capturedOnScan?.("0123456789012");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(windowOpen()).toBeNull();
  });
});
