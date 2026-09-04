import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * CreateOrderModal's own zod schema (`notes`/`urgent`/`fulfillPath`) has NO
 * required fields — react-hook-form's resolver never blocks a submit. The
 * real "required" guardrails (must pick a customer, must add a line item) are
 * imperative React state checks in `onSubmit` (`setCustomerError`/
 * `setLineItemsError`), not react-hook-form/zod validation. This spec covers
 * that actual guard instead of a nonexistent zod message. A full happy path
 * (search + select a customer, search + add a product, then submit) needs a
 * much larger mocked surface — debounced customer/product search dropdowns
 * backed by 6+ query hooks — and is out of scope for this pass; recorded as a
 * finding, not faked.
 */

const createOrderMutate = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
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
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("CreateOrderModal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("blocks submit with 'Please select a customer' and never calls the create mutation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: /^create order$/i }));

    expect(await screen.findByText("Please select a customer")).toBeInTheDocument();
    expect(createOrderMutate).not.toHaveBeenCalled();
  });
});
