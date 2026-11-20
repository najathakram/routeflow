import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { Estimate } from "@/lib/api/estimates";
import { CreateEstimateModal } from "./EstimateFormModal";

// The owner's gaps (2026-11-19): a quote line's price can be typed, and a draft opens in the same form and saves
// through PATCH with each stored line named. Harness: page.price-layer.test.tsx (flag off, list $42, tier 3 $36).
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => false }));
let mockPriceRights = true;
jest.mock("@/lib/api/my-permissions", () => ({
  ...jest.requireActual("@/lib/api/my-permissions"),
  usePriceEditAllowed: () => mockPriceRights,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn(() => Promise.reject(new Error("nope"))), post: jest.fn() },
}));
jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useCreateEstimate: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateEstimate: () => ({ mutate: mockUpdate, isPending: false }),
}));
const CUSTOMER = { id: "cust-1", businessName: "Acme Foods", contactName: "Jane", pricingTier: 3 };
const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  sku: "WID-1",
  unit: "each",
  pricePerUnit: 42,
  priceTier3: 36,
  isActive: true,
};
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [CUSTOMER] }, isLoading: false, isError: false }),
  useCustomer: () => ({ data: CUSTOMER, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false, refetch: jest.fn() }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PRODUCT] }, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

const DRAFT: Estimate = {
  id: "est-1",
  estimateNumber: "EST-2026-0001",
  customerId: "cust-1",
  customer: { id: "cust-1", businessName: "Acme Foods" },
  status: "DRAFT",
  issueDate: "2026-11-19T00:00:00.000Z",
  expiresAt: "2026-12-19T00:00:00.000Z",
  subtotal: 60,
  total: 60,
  notes: "Call before delivery",
  terms: "Net 30",
  items: [
    {
      id: "item-1",
      productId: "prod-1",
      description: "Widget",
      qty: 2,
      unitPrice: 30,
      priceType: "DISCOUNTED",
      originalPrice: 42,
    },
  ],
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPriceRights = true;
});
const submit = (dialog: HTMLElement, name: string) =>
  userEvent.setup().click(within(dialog).getByRole("button", { name }));

describe("estimate form: a typed line price", () => {
  it("a new estimate sends the typed price; an untouched line sends none", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateEstimateModal isOpen onClose={jest.fn()} onSuccess={jest.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/search customers/i), "Acme");
    await user.click(await within(dialog).findByText("Acme Foods"));
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "Widget");
    await user.click(await within(dialog).findByText("Widget"));

    const price = await within(dialog).findByLabelText("Price for Widget");
    expect(price).toHaveValue("36.00"); // the customer's tier price, before typing
    await user.clear(price);
    await user.type(price, "44.5");
    expect(within(dialog).getByText("MANUAL")).toBeInTheDocument(); // above the $42 list

    await submit(dialog, "Create estimate");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].items).toEqual([
      { productId: "prod-1", description: "Widget", qty: 1, unitPrice: 44.5 },
    ]);
  });

  it("a price that is not a number blocks the save with a message", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateEstimateModal isOpen onClose={jest.fn()} onSuccess={jest.fn()} estimate={DRAFT} />,
    );
    const dialog = await screen.findByRole("dialog");
    const price = await within(dialog).findByLabelText("Price for Widget");
    await user.clear(price);
    await user.type(price, "abc");
    await submit(dialog, "Save changes");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/enter a price/i)).toBeInTheDocument();
  });
});

describe("estimate form: edit a draft", () => {
  it("opens with the draft's customer, line, price, notes and terms", async () => {
    renderWithProviders(
      <CreateEstimateModal isOpen onClose={jest.fn()} onSuccess={jest.fn()} estimate={DRAFT} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit EST-2026-0001")).toBeInTheDocument();
    expect(within(dialog).getByText("Acme Foods")).toBeInTheDocument();
    expect(await within(dialog).findByLabelText("Price for Widget")).toHaveValue("30.00");
    expect(within(dialog).getByDisplayValue("Call before delivery")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("Net 30")).toBeInTheDocument();
  });

  it("saves through PATCH, naming the stored line and re-sending its typed price", async () => {
    const user = userEvent.setup();
    const onSuccess = jest.fn();
    mockUpdate.mockImplementation((_v: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    renderWithProviders(
      <CreateEstimateModal isOpen onClose={jest.fn()} onSuccess={onSuccess} estimate={DRAFT} />,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText("Price for Widget");
    const terms = within(dialog).getByDisplayValue("Net 30");
    await user.clear(terms);
    await user.type(terms, "Net 15");
    await submit(dialog, "Save changes");

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const { id, dto } = mockUpdate.mock.calls[0][0];
    expect(id).toBe("est-1");
    expect(dto).toMatchObject({
      customerId: "cust-1",
      issueDate: "2026-11-19",
      expiresAt: "2026-12-19",
      notes: "Call before delivery",
      terms: "Net 15",
    });
    expect(dto.items).toEqual([
      { id: "item-1", productId: "prod-1", description: "Widget", qty: 2, unitPrice: 30 },
    ]);
    expect(onSuccess).toHaveBeenCalledWith("est-1");
  });

  it("without price rights: no price box, and the held typed price is re-sent unchanged", async () => {
    mockPriceRights = false;
    const user = userEvent.setup();
    renderWithProviders(
      <CreateEstimateModal isOpen onClose={jest.fn()} onSuccess={jest.fn()} estimate={DRAFT} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("$30.00/each")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Price for Widget")).not.toBeInTheDocument();
    const notes = within(dialog).getByDisplayValue("Call before delivery");
    await user.clear(notes);
    await user.type(notes, "Ring the bell");
    await submit(dialog, "Save changes");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].dto.items).toEqual([
      { id: "item-1", productId: "prod-1", description: "Widget", qty: 2, unitPrice: 30 },
    ]);
  });
});
