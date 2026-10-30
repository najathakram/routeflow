import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * W-882: the builder's footer and panel total are saleTotals' figure, not `subtotal * rate`. $10.00 at 8.25% is $10.83
 * (the inline math footed $10.82), the tax label names a percent only when a rate is set, a regulated levy is its own
 * named row, and a tax-exempt customer owes neither.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const mockState: {
  taxRate: number | undefined;
  exempt: boolean;
  categories: unknown[];
  trackedCategoryId: string | null;
} = { taxRate: 8.25, exempt: false, categories: [], trackedCategoryId: null };

const mockProduct = () => ({
  id: "p-ten",
  name: "Sample Pallet",
  sku: "900800700",
  unit: "each",
  pricePerUnit: "10.00",
  isActive: true,
  trackedCategoryId: mockState.trackedCategoryId,
});

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: mockState.exempt ? { isTaxExempt: true } : undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [mockProduct()] } }),
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
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: mockState.categories }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(() =>
      Promise.resolve({
        data: mockState.taxRate === undefined ? {} : { taxRate: mockState.taxRate },
      }),
    ),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

async function addLine() {
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: "pallet" },
  });
  fireEvent.click(await screen.findByRole("option", { name: /sample pallet/i }));
}

beforeEach(() => {
  mockState.taxRate = 8.25;
  mockState.exempt = false;
  mockState.categories = [];
  mockState.trackedCategoryId = null;
});

describe("CreateOrderModal totals (W-882)", () => {
  it("$10.00 at 8.25%: the footer and the panel both read $10.83", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addLine();
    await waitFor(() =>
      expect(screen.getByTestId("create-order-footer-total")).toHaveTextContent("$10.83"),
    );
    expect(screen.getByTestId("totals-summary-total")).toHaveTextContent("$10.83");
    expect(screen.getByText("Tax (8.25%)")).toBeInTheDocument();
  });

  it("no tax rate set: the label reads Tax, never a made-up 10%", async () => {
    mockState.taxRate = undefined;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addLine();
    await screen.findByTestId("totals-summary");
    expect(screen.getByText("Tax")).toBeInTheDocument();
    expect(screen.queryByText(/10%/)).toBeNull();
  });

  it("a regulated per-unit levy is in the total and its own named row", async () => {
    mockState.taxRate = 0;
    mockState.trackedCategoryId = "c1";
    mockState.categories = [
      { id: "c1", name: "CRV deposit", taxType: "EXCISE_PER_UNIT", rate: "0.5", active: true },
    ];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await addLine();
    const row = await screen.findByTestId("totals-charge-row");
    expect(row).toHaveTextContent("CRV deposit");
    expect(row).toHaveTextContent("$0.50");
    expect(screen.getByTestId("totals-summary-total")).toHaveTextContent("$10.50");
  });
});
