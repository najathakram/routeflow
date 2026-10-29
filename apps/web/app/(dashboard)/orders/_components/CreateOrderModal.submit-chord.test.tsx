import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};

const PARENT = {
  id: "p-parent",
  name: "Sample Juice",
  sku: "JUICE",
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [
    {
      id: "v-1",
      name: "Sample Juice 1L",
      variantName: "1L",
      sku: "J1",
      unit: "each",
      pricePerUnit: "3.00",
    },
    {
      id: "v-2",
      name: "Sample Juice 2L",
      variantName: "2L",
      sku: "J2",
      unit: "each",
      pricePerUnit: "5.00",
    },
  ],
};
let mockProducts: unknown[] = [PLAIN];

const CUSTOMERS = [
  {
    id: "c1",
    businessName: "Acme Market",
    contactName: "Ann",
    pricingTier: 3,
    fulfillPath: "SHIP",
  },
  { id: "c2", businessName: "Acme Deli", contactName: "Bo", pricingTier: 1, fulfillPath: "ROUTE" },
];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: CUSTOMERS } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const mockCreateMutate = jest.fn();
let mockCreateError: unknown = null;
const mockCreateDraft = jest.fn().mockResolvedValue({ id: "d1" });
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useCreditNotes: (p?: { customerId?: string }) => ({
    data: {
      data: p?.customerId
        ? [
            {
              id: "cn1",
              status: "ISSUED",
              amount: 10,
              amountUsed: 0,
              creditNoteNumber: "CN-1",
              reason: "damaged",
            },
          ]
        : [],
    },
  }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: mockCreateMutate,
    isPending: false,
    error: mockCreateError,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: mockCreateDraft, isPending: false }),
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

const cust = () => screen.getByPlaceholderText(/search by business name/i) as HTMLInputElement;
const prod = () =>
  screen.getByPlaceholderText(/search by name, sku or scan barcode/i) as HTMLInputElement;
const rowBtn = async (name: RegExp) =>
  (await screen.findByText(name)).closest("button") as HTMLElement;
const creditBox = async () =>
  (await screen.findByText("CN-1")).closest("label")!.querySelector("input") as HTMLInputElement;
const chip = () => screen.queryByRole("button", { name: "Change customer" });
const listbox = () => screen.queryByRole("listbox", { name: "Customers" });

beforeEach(() => {
  jest.clearAllMocks();
  mockProducts = [PLAIN];
  mockCreateError = null;
  mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false, product: null });
});

async function typeCustomer(user: ReturnType<typeof userEvent.setup>, text = "acme") {
  await user.type(cust(), text);
  await rowBtn(/Acme Market/);
}

/**
 * apple-ux r5 N04: Ctrl/Cmd+Enter creates the order from any field, the same chord as Edit Items' F05 save. A chord,
 * never a bare key: Enter alone in a field still does not submit. The Create Order button advertises it
 * (`aria-keyshortcuts`) and shows a small hint.
 */
async function readyOrder(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  await typeCustomer(user);
  await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
  await user.type(prod(), "cola");
  await user.click(await rowBtn(/Sample Cola/));
  return document.querySelector<HTMLInputElement>('input[aria-label="Quantity"]')!;
}

describe("Create Order submit chord (N04)", () => {
  it("advertises the chord on Create Order: aria-keyshortcuts plus a visible hint", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const create = screen.getByRole("button", { name: "Create Order" });
    expect(create).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    expect(within(create).getByTestId("create-order-chord-hint")).toHaveTextContent(
      /(Ctrl|⌘)\+?↵|Enter/,
    );
  });

  it("Ctrl+Enter in the quantity field creates the order once", async () => {
    const user = userEvent.setup({ delay: null });
    const qty = await readyOrder(user);
    await user.click(qty);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
  });

  it("Cmd+Enter in the product search creates the order too", async () => {
    const user = userEvent.setup({ delay: null });
    await readyOrder(user);
    await user.click(prod());
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
  });

  it("bare Enter in a field still does not submit", async () => {
    const user = userEvent.setup({ delay: null });
    const qty = await readyOrder(user);
    await user.click(qty);
    await user.keyboard("{Enter}");
    await user.click(prod());
    await user.keyboard("{Enter}");
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Enter and Alt+Ctrl+Enter are not the chord", async () => {
    const user = userEvent.setup({ delay: null });
    const qty = await readyOrder(user);
    await user.click(qty);
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await user.keyboard("{Control>}{Alt>}{Enter}{/Alt}{/Control}");
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("does nothing while Create Order is disabled (no customer, no lines: the form's own guard answers)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const user = userEvent.setup({ delay: null });
    await user.click(cust());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });
});
