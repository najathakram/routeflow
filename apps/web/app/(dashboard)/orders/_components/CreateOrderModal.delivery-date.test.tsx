import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Orders r3 F09 + F12 + F13: the Requested Delivery Date sits directly under the Customer picker (visible
 * without scrolling once lines are added), stays optional, and a date before today is refused next to the
 * field - the value is kept, the message says what to do, and Create Order does not send it.
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
let mockProducts: unknown[] = [PLAIN];

const CUSTOMERS = [
  { id: "c1", businessName: "Acme Deli", contactName: "Bo", pricingTier: 1, fulfillPath: "ROUTE" },
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
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useCreditNotes: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: mockCreateMutate,
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
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const dateField = () => screen.getByLabelText(/requested delivery date/i) as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: "Create Order" });
const PAST_MESSAGE = /pick today or a later date/i;

/** The browser's local calendar day, as the date input writes it (YYYY-MM-DD). */
const localDay = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function openWithCustomerAndLine() {
  const user = userEvent.setup({ delay: null });
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  await user.type(screen.getByPlaceholderText(/search by business name/i), "acme");
  await user.click((await screen.findByText(/Acme Deli/)).closest("button") as HTMLElement);
  await user.type(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), "cola");
  await user.click((await screen.findByText(/Sample Cola/)).closest("button") as HTMLElement);
  return user;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProducts = [PLAIN];
});

describe("Requested Delivery Date placement (F09 + F12)", () => {
  it("renders right after the customer and before the products, with a line added", async () => {
    await openWithCustomerAndLine();
    const field = dateField();
    const customer = screen.getByRole("button", { name: "Change customer" });
    const productSearch = screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
    const followedBy = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(followedBy(customer, field)).toBe(true);
    expect(followedBy(field, productSearch)).toBe(true);
    expect(followedBy(field, screen.getByText("Sample Cola", { selector: "p" }))).toBe(true);
  });

  it("stays optional: an order goes out with no delivery date", async () => {
    const user = await openWithCustomerAndLine();
    expect(dateField()).toHaveValue("");
    await user.click(createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBeUndefined();
  });

  it("a future date still goes out as requestedDeliveryDate", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(3) } });
    await user.click(createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(3));
  });
});

describe("A delivery date in the past is refused (F13)", () => {
  it("shows what to do next to the field, keeps the typed value, and does not submit it", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    const message = screen.getByText(PAST_MESSAGE);
    expect(message).toBeVisible();
    expect(dateField()).toHaveValue("2025-10-26");
    expect(dateField()).toHaveAttribute("aria-invalid", "true");
    expect(dateField()).toHaveAccessibleDescription(message.textContent ?? "");
    await user.click(createButton());
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(dateField()).toHaveValue("2025-10-26");
  });

  it("yesterday is refused; today and a later date are accepted", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: localDay(-1) } });
    expect(screen.getByText(PAST_MESSAGE)).toBeInTheDocument();
    fireEvent.change(dateField(), { target: { value: localDay(0) } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    expect(dateField()).not.toHaveAttribute("aria-invalid", "true");
    await user.click(createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(0));
  });

  it("fixing the date clears the message and lets the order go", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    await user.click(createButton());
    expect(mockCreateMutate).not.toHaveBeenCalled();
    fireEvent.change(dateField(), { target: { value: localDay(5) } });
    expect(screen.queryByText(PAST_MESSAGE)).toBeNull();
    await user.click(createButton());
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].requestedDeliveryDate).toBe(localDay(5));
  });

  it("Save as draft does not send a past date either", async () => {
    const user = await openWithCustomerAndLine();
    fireEvent.change(dateField(), { target: { value: "2025-10-26" } });
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });
});
