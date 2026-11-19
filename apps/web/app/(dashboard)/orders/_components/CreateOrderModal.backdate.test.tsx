import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { installScanClock } from "@/test-utils/scan-clock";

/**
 * W-1188 PR-3: the regular order's date is one chip (office policy, past-only) in place of the "Backdate this order" link,
 * the "Order date (optional)" input and "Use today". The cap is the TENANT's today, not the browser's UTC day (R23).
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

// 20:00 in Chicago on Mon 2026-11-09 is already Tue 2026-11-10 in UTC: the old UTC cap would let tomorrow through.
jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => "2026-11-09",
}));

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
let mockDraft: unknown = undefined;

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
  useDraft: () => ({ data: mockDraft, isFetching: false }),
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

const chip = () => screen.getByTestId("counter-date-chip");
const chipButton = () => within(chip()).getAllByRole("button")[0];
const oldLink = () => screen.queryByRole("button", { name: "Backdate this order" });

beforeEach(() => {
  jest.clearAllMocks();
  mockDraft = undefined;
  mockProducts = [];
  mockCreateError = null;
});

installScanClock(); // SA-1159: key stamps through the constants, never the wall clock

describe("order date chip on the regular order (W-1188 PR-3)", () => {
  it("shows the chip on Today and none of the old controls", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    expect(oldLink()).toBeNull();
    expect(document.getElementById("order-date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use today" })).toBeNull();
  });

  it("R23: the calendar stops at the business's today, not the UTC day", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    const day = (d: string) => document.querySelector(`[data-day="${d}"]`) as HTMLButtonElement;
    expect(day("2026-11-09")).not.toBeDisabled();
    expect(day("2026-11-10")).toBeDisabled();
  });

  it("tells the clerk a future day is the delivery date", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    expect(screen.getByTestId("counter-date-office-hint")).toHaveTextContent(
      "A future day? Set the delivery date instead.",
    );
    await user.type(screen.getByTestId("counter-date-input"), "tomorrow");
    expect(screen.getByTestId("counter-date-echo")).toHaveTextContent(
      "A future day? Set the delivery date instead.",
    );
  });

  it("W-1188 r4: a scan while the picker is open in the order modal is inert: no lookup, no line, the picker stays open with the note", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    const picker = await screen.findByTestId("counter-date-picker");
    act(() =>
      within(picker)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await user.keyboard("4006381333931{Enter}");
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
    expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
    expect(screen.getByTestId("counter-date-scan-note")).toBeInTheDocument();
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  const fillOrder = async (user: ReturnType<typeof userEvent.setup>, resumeDraftId?: string) => {
    mockProducts = [PLAIN];
    renderWithProviders(
      <CreateOrderModal isOpen onClose={jest.fn()} resumeDraftId={resumeDraftId} />,
    );
    await user.type(screen.getByPlaceholderText(/search by business name/i), "acme");
    await user.click((await screen.findByText(/Acme Deli/)).closest("button") as HTMLElement);
    await user.type(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), "cola");
    await user.click((await screen.findByText(/Sample Cola/)).closest("button") as HTMLElement);
  };

  it("Today sends no orderDate", async () => {
    const user = userEvent.setup({ delay: null });
    await fillOrder(user);
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].orderDate).toBeUndefined();
  });

  it("a chosen day goes out as orderDate on Create Order", async () => {
    const user = userEvent.setup({ delay: null });
    await fillOrder(user);
    await user.click(chipButton());
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    expect(chip()).toHaveAttribute("data-direction", "BACK");
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].orderDate).toBe("2026-11-08");
  });

  it("clearing the chip returns to Today in one tap", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    await user.click(screen.getByRole("button", { name: "Clear the order date, back to today" }));
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });

  it("a resumed draft that already has an order date shows it on the chip", async () => {
    mockDraft = {
      id: "d1",
      kind: "ORDER",
      payload: { customer: null, lineItems: [], orderDate: "2026-10-01" },
    };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} resumeDraftId="d1" />);
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    expect(chip()).toHaveTextContent("Dated Thu, Oct 1");
  });

  it("a draft whose stored day is today reads Today and sends no orderDate", async () => {
    const user = userEvent.setup({ delay: null });
    mockDraft = {
      id: "d1",
      kind: "ORDER",
      payload: { customer: null, lineItems: [], orderDate: "2026-11-09" },
    };
    await fillOrder(user, "d1");
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "TODAY"));
    expect(screen.queryByRole("button", { name: /Clear the order date/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].orderDate).toBeUndefined();
  });

  it("Enter on the clear x clears the date inside the order form", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    screen.getByRole("button", { name: "Clear the order date, back to today" }).focus();
    await user.keyboard("{Enter}");
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });

  it("reopening the builder puts the chip back on Today", async () => {
    const user = userEvent.setup({ delay: null });
    const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.click(chipButton());
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    view.rerender(<CreateOrderModal isOpen={false} onClose={jest.fn()} />);
    view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });
});

describe("Counter-path tap targets (row 296): >= 44px hit areas", () => {
  it("the Change customer X is 44px tall and wide", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(screen.getByPlaceholderText(/search by business name/i), "acme");
    await user.click((await screen.findByText(/Acme Deli/)).closest("button") as HTMLElement);
    const x = screen.getByRole("button", { name: "Change customer" });
    expect(x).toHaveClass("min-h-[44px]");
    expect(x).toHaveClass("min-w-[44px]");
  });
});
