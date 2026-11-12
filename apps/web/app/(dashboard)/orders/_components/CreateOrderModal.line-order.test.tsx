import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * W-1187 PR-2b: the order builder's lines can be dragged into any order. The list is local until the order is created, and
 * its array order is the order the order is sent in (the server stores `position` by array index; the invoice follows). A move
 * is a reorder of the array, no request. Focus stays on the moved row's handle. A scan burst never moves a line, and a repeat
 * pick of a product already on the order raises its quantity in place.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const P = (id: string, name: string, sku: string) => ({
  id,
  name,
  sku,
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
});
const COLA = P("p-cola", "Sample Cola", "100");
const WATER = P("p-water", "Sample Water", "200");
const JUICE = P("p-juice", "Sample Juice", "300");

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: { data: [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }] },
  }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [COLA, WATER, JUICE] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const createOrderMutate = jest.fn();
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: (...a: unknown[]) => createOrderMutate(...a),
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
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
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
type Toast = {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
};
const mockToast = jest.fn((o: Toast): string => {
  void o;
  return "t1";
});
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

let now = 1000;
beforeEach(() => {
  jest.clearAllMocks();
  now += 100_000; // the scan-safety guard remembers the last key across tests: the clock only moves forward
  jest.spyOn(performance, "now").mockImplementation(() => now);
  mockResolveProductByCode.mockImplementation(async (code: string) => {
    const p = [COLA, WATER, JUICE].find((x) => x.sku === code);
    return p ? { notFound: false, archived: false, product: p } : { notFound: true };
  });
});
afterEach(() => jest.restoreAllMocks());

const human = () => {
  now += 150;
};
const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
}
const list = () => screen.getAllByRole("list").find((ul) => ul.querySelector('[title="Remove"]'))!;
const names = () =>
  within(list())
    .getAllByRole("listitem")
    .map((li) => /Sample (Cola|Water|Juice)/.exec(li.textContent ?? "")?.[0]);
const handle = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Move ${name}, line`) });
const lastToast = (): Toast => mockToast.mock.calls[mockToast.mock.calls.length - 1][0];

async function build(...items: string[]) {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  for (const n of items) {
    await pick(n);
    await waitFor(() => expect(screen.getAllByText(n).length).toBeGreaterThan(0));
  }
}
async function alt(name: string, key: "ArrowUp" | "ArrowDown") {
  human();
  await act(async () => {
    fireEvent.keyDown(handle(name), { key, code: key, altKey: true });
  });
}

describe("CreateOrderModal: drag a line into any order (W-1187 PR-2b)", () => {
  it("each line of a two-line order has a labelled handle; one line has none", async () => {
    await build("Sample Cola");
    expect(screen.queryByRole("button", { name: /^Move Sample Cola/ })).toBeNull();
    await pick("Sample Water");
    await waitFor(() => expect(handle("Sample Water")).toBeInTheDocument());
    expect(handle("Sample Cola")).toHaveAccessibleName("Move Sample Cola, line 1 of 2");
    expect(handle("Sample Water")).toHaveAccessibleName("Move Sample Water, line 2 of 2");
  });

  it("the handle sits in the row's own slot, fully visible: absolute, 24 px wide, no negative margin (#4292)", async () => {
    await build("Sample Cola", "Sample Water");
    const slot = handle("Sample Cola").parentElement!;
    expect(slot.className).toContain("absolute inset-y-0 left-0");
    expect(slot.className).toContain("[&>button]:ml-0");
    expect(slot.className).toContain("[&>button]:w-6");
    expect(handle("Sample Cola").className).toContain("h-11");
    expect(slot.parentElement!.className).toContain("relative");
    expect(slot.parentElement!.className).toContain("pl-8");
  });

  it("Alt+ArrowDown moves the line and says 'Moved Sample Cola to line 2' with Undo; focus stays on the moved row's handle", async () => {
    await build("Sample Cola", "Sample Water");
    handle("Sample Cola").focus();
    await alt("Sample Cola", "ArrowDown");
    expect(names()).toEqual(["Sample Water", "Sample Cola"]);
    expect(lastToast().title).toBe("Moved Sample Cola to line 2");
    expect(lastToast().action?.label).toBe("Undo");
    await waitFor(() => expect(handle("Sample Cola")).toHaveFocus());
  });

  it("Undo puts the order back; Ctrl+Z does the same when focus is not in a text field", async () => {
    await build("Sample Cola", "Sample Water");
    handle("Sample Cola").focus();
    await alt("Sample Cola", "ArrowDown");
    act(() => lastToast().action!.onClick());
    expect(names()).toEqual(["Sample Cola", "Sample Water"]);
    await alt("Sample Cola", "ArrowDown");
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(names()).toEqual(["Sample Cola", "Sample Water"]);
  });

  it("the order is sent in the dragged order", async () => {
    await build("Sample Cola", "Sample Water", "Sample Juice");
    handle("Sample Juice").focus();
    await alt("Sample Juice", "ArrowUp");
    await alt("Sample Juice", "ArrowUp");
    expect(names()).toEqual(["Sample Juice", "Sample Cola", "Sample Water"]);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createOrderMutate).toHaveBeenCalled());
    expect(
      createOrderMutate.mock.calls[0][0].items.map((i: { productId: string }) => i.productId),
    ).toEqual(["p-juice", "p-cola", "p-water"]);
  });

  it("a repeat pick raises the quantity in place; a new product goes to the end", async () => {
    await build("Sample Cola", "Sample Water");
    handle("Sample Cola").focus();
    await alt("Sample Cola", "ArrowDown"); // Water, Cola
    await pick("Sample Water");
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Added to existing line" }),
      ),
    );
    expect(names()).toEqual(["Sample Water", "Sample Cola"]);
    await pick("Sample Juice");
    await waitFor(() => expect(names()).toEqual(["Sample Water", "Sample Cola", "Sample Juice"]));
  });

  it("a digit burst + Enter while a handle holds focus lands in the search box as a scan; nothing moves", async () => {
    await build("Sample Cola", "Sample Water");
    handle("Sample Water").focus();
    await userEvent.keyboard("300{Enter}", { delay: null });
    expect(search()).toHaveFocus();
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledWith("300"));
    await waitFor(() => expect(names()).toEqual(["Sample Cola", "Sample Water", "Sample Juice"]));
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/^Moved /) }),
    );
  });

  it("a burst of arrow keys + Enter on a focused handle moves and picks up nothing", async () => {
    await build("Sample Cola", "Sample Water");
    const h = handle("Sample Cola");
    h.focus();
    for (const code of ["ArrowDown", "ArrowDown", "ArrowUp", "Enter"]) {
      fireEvent.keyDown(h, { key: code, code });
      now += 2;
    }
    expect(names()).toEqual(["Sample Cola", "Sample Water"]);
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/^Moved /) }),
    );
  });

  it("removing a line keeps the others in their dragged order", async () => {
    await build("Sample Cola", "Sample Water", "Sample Juice");
    handle("Sample Juice").focus();
    await alt("Sample Juice", "ArrowUp"); // Cola, Juice, Water
    const removeWater = within(list()).getAllByTitle("Remove")[2];
    fireEvent.click(removeWater);
    expect(names()).toEqual(["Sample Cola", "Sample Juice"]);
  });
});
