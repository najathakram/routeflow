import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Row 100 (owner-approved UX D): the "Order date" field moves behind a "Backdate this order" link. It is the same existing
 * control (same id, same max, same helper text, same payload field) - no new field - and it shows by itself when a parked
 * draft already carries an order date, so nothing is hidden from someone who needs it.
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

const orderDateInput = () => screen.queryByLabelText(/^Order date/) as HTMLInputElement | null;
const backdateLink = () => screen.queryByRole("button", { name: "Backdate this order" });

beforeEach(() => {
  jest.clearAllMocks();
  mockProducts = [];
  mockCreateError = null;
});

describe("Backdate this order (row 100)", () => {
  it("starts with a link, not the date field", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(backdateLink()).toBeInTheDocument();
    expect(orderDateInput()).toBeNull();
  });

  it("the link opens the existing Order date field (same max, same helper text) and focuses it", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(backdateLink()!);
    const field = orderDateInput()!;
    expect(field).toBeInTheDocument();
    expect(field).toHaveAttribute("type", "date");
    expect(field).toHaveAttribute("max");
    expect(field).toHaveFocus();
    expect(screen.getByText(/The day the order actually happened/)).toBeInTheDocument();
    expect(backdateLink()).toBeNull();
  });

  it("'Use today' clears the date and folds the field back behind the link", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(backdateLink()!);
    fireEvent.change(orderDateInput()!, { target: { value: "2026-10-01" } });
    expect(orderDateInput()).toHaveValue("2026-10-01");
    await user.click(screen.getByRole("button", { name: "Use today" }));
    expect(orderDateInput()).toBeNull();
    expect(backdateLink()).toBeInTheDocument();
  });

  it("the chosen date still goes out as orderDate on Create Order", async () => {
    mockProducts = [
      {
        id: "p-plain",
        name: "Sample Cola",
        sku: "100200300",
        unit: "each",
        pricePerUnit: "2.50",
        isActive: true,
      },
    ];
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(screen.getByPlaceholderText(/search by business name/i), "acme");
    await user.click((await screen.findByText(/Acme Deli/)).closest("button") as HTMLElement);
    await user.type(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), "cola");
    await user.click((await screen.findByText(/Sample Cola/)).closest("button") as HTMLElement);
    await user.click(backdateLink()!);
    fireEvent.change(orderDateInput()!, { target: { value: "2026-10-01" } });
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].orderDate).toBe("2026-10-01");
  });

  it("a parked draft that already has an order date shows the field straight away", () => {
    // The hydrated draft path sets orderDate; the field must not hide a date someone already chose.
    const src = fs.readFileSync(path.join(__dirname, "CreateOrderModal.tsx"), "utf8");
    expect(src).toMatch(/showOrderDate\s*=\s*backdateOpen\s*\|\|\s*!!orderDate/);
  });

  it("reopening the builder folds it back behind the link", async () => {
    const user = userEvent.setup({ delay: null });
    const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(backdateLink()!);
    expect(orderDateInput()).toBeInTheDocument();
    view.rerender(<CreateOrderModal isOpen={false} onClose={jest.fn()} />);
    view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(orderDateInput()).toBeNull();
    expect(backdateLink()).toBeInTheDocument();
  });
});
