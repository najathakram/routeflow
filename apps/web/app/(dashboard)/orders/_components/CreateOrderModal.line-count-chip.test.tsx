import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * W-1185: the order builder shows the running item count beside the total, so the person entering
 * lines can check it against the goods before saving. Harness as CreateOrderModal.footer-total.test.tsx.
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
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

async function add(search: string, name: RegExp) {
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: search },
  });
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("CreateOrderModal item count chip (W-1185)", () => {
  it("shows no chip while the order has no lines", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.queryByTestId("line-count-chip")).not.toBeInTheDocument();
  });

  it("sits in the sticky footer beside the total and follows every added line", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await add("chips", /sample chips/i);
    const chip = await screen.findByTestId("line-count-chip");
    expect(chip).toHaveTextContent("1 line · 1 box");
    expect(screen.getByTestId("create-order-footer")).toContainElement(chip);
    expect(
      within(screen.getByTestId("create-order-footer-total")).getByTestId("line-count-chip"),
    ).toBe(chip);
    await add("cola", /sample cola/i);
    expect(screen.getByTestId("line-count-chip")).toHaveTextContent("2 lines · 1 box · 1 pc");
  });
});
