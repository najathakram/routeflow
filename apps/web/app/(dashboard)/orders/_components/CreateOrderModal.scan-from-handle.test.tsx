import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * W-1187 PR-2b: a scan that starts while a line handle holds focus is looked up WHOLE. The REAL wedge detector
 * (BarcodeScannerButton, not mocked) listens for keydown on the search input only, so the first key, typed on the handle,
 * has to reach it as its own keydown or the code arrives one character short.
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

const CODE = "1234567890123";
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveProductByCode.mockResolvedValue({ notFound: true });
});
afterEach(() => jest.restoreAllMocks());

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
}
const handle = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Move ${name}, line`) });
async function build() {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  for (const n of ["Sample Cola", "Sample Water"]) {
    await pick(n);
    await waitFor(() => expect(screen.getAllByText(n).length).toBeGreaterThan(0));
  }
}

describe("CreateOrderModal: a scan that starts on a line handle (real detector)", () => {
  it("control: focus in the search box, the whole code is looked up", async () => {
    await build();
    search().focus();
    await userEvent.keyboard(`${CODE}{Enter}`, { delay: null });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));
    expect(mockResolveProductByCode).toHaveBeenCalledWith(CODE);
  });

  it("focus on a line handle at key 1: the code looked up equals the code scanned, whole", async () => {
    await build();
    handle("Sample Water").focus();
    await userEvent.keyboard(`${CODE}{Enter}`, { delay: null });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));
    expect(mockResolveProductByCode).toHaveBeenCalledWith(CODE);
  });

  it("the first handle too, and the line order is unchanged", async () => {
    await build();
    handle("Sample Cola").focus();
    await userEvent.keyboard(`${CODE}{Enter}`, { delay: null });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));
    expect(mockResolveProductByCode).toHaveBeenCalledWith(CODE);
    const cola = screen.getAllByText("Sample Cola")[0];
    const water = screen.getAllByText("Sample Water")[0];
    expect(cola.compareDocumentPosition(water) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
