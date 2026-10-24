import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { calendarDayInZone } from "@/lib/calendar-date";

/**
 * Row 661 (Ask 1, steps 2-3): the Account strip sits under the picked customer on New order, and a credit-limit
 * refusal offers "Record payment" for that customer. Mocked at the api-client boundary; the payment dialog is stubbed
 * (it has its own specs) so the test can drive its onSuccess. The order draft must survive a payment untouched.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const ZONE = "America/Chicago";
const TODAY = calendarDayInZone(ZONE);
const isoDay = (offset: number) => {
  const [y, m, d] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString();
};

let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", tenantId: "t1", role: mockRole } }),
  };
});

const createOrderMutate = jest.fn();
const createOrderReset = jest.fn();
let mockCreateOrderError: unknown = null;
let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
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
    error: mockCreateOrderError,
    reset: createOrderReset,
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
jest.mock("@/lib/api/tobacco", () => ({
  ...jest.requireActual("@/lib/api/tobacco"),
  useHasAddon: () => false,
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => false,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

let statement: Record<string, unknown> = { outstandingAmount: 420, overdueAmount: 420 };
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string) => {
      if (url === "/customers/c1")
        return Promise.resolve({ data: { id: "c1", creditLimit: 5000 } });
      if (url === "/customers/c1/statement") return Promise.resolve({ data: statement });
      if (url === "/settings") return Promise.resolve({ data: { timezone: "America/Chicago" } });
      if (url === "/settings/invoice") return Promise.resolve({ data: { defaultTerms: "Net 30" } });
      if (url === "/invoices") {
        return Promise.resolve({
          data: {
            data: [
              {
                id: "inv-1",
                invoiceNumber: "INV-1001",
                status: "OVERDUE",
                issueDate: isoDay(-64),
                dueDate: isoDay(-34),
                balanceDue: 420,
              },
            ],
            meta: { total: 1, page: 1, limit: 100, totalPages: 1 },
          },
        });
      }
      return Promise.resolve({ data: { taxRate: 0 } });
    }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

let modalProps: { customerId: string; focusInvoiceId?: string; onSuccess?: () => void } | null =
  null;
jest.mock("@/components/CustomerRecordPaymentModal", () => ({
  CustomerRecordPaymentModal: (p: {
    customerId: string;
    focusInvoiceId?: string;
    onSuccess?: () => void;
    onClose: () => void;
  }) => {
    modalProps = p;
    return (
      <div role="dialog" aria-label="Record payment stub">
        <button
          onClick={() => {
            p.onSuccess?.();
            p.onClose();
          }}
        >
          stub-pay
        </button>
      </div>
    );
  },
}));

const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 2 };
const pickCustomer = async (name: string) => {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: name.slice(0, 3) },
  });
  fireEvent.click(await screen.findByText(name));
};
const creditRefusal = {
  response: {
    status: 409,
    data: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 110, message: "Over." },
  },
};

describe("CreateOrderModal: Account strip and the credit-limit payment shortcut (row 661)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = "OPERATOR";
    mockCustomers = [acme];
    mockCreateOrderError = null;
    modalProps = null;
    statement = { outstandingAmount: 420, overdueAmount: 420 };
  });

  it("shows nothing before a customer is picked, then the strip under the customer, before Order again", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.queryByTestId("account-strip")).not.toBeInTheDocument();
    await pickCustomer("Acme Foods");
    expect(await screen.findByTestId("account-strip-line")).toHaveTextContent(
      "Owes $420.00 · 1 open · 1 overdue, oldest 34 days",
    );
    const strip = screen.getByTestId("account-strip");
    const customerRow = screen.getByText("Acme Foods");
    expect(
      customerRow.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const productsHeading = screen.getByText("Products");
    expect(
      strip.compareDocumentPosition(productsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Mark paid keeps the order draft untouched: the notes and the customer survive a payment", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer("Acme Foods");
    const notes = screen.getByLabelText(/notes/i) as HTMLTextAreaElement;
    await user.type(notes, "Leave at the back door");
    await screen.findByTestId("account-strip-line");
    await user.click(screen.getByRole("button", { name: /view/i }));
    await user.click(await screen.findByRole("button", { name: "Mark paid" }));
    expect(modalProps).toEqual(
      expect.objectContaining({ customerId: "c1", focusInvoiceId: "inv-1" }),
    );

    statement = { outstandingAmount: 0, overdueAmount: 0 };
    await user.click(screen.getByRole("button", { name: "stub-pay" }));

    expect(createOrderMutate).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/notes/i) as HTMLTextAreaElement).value).toBe(
      "Leave at the back door",
    );
    expect(screen.getByText("Acme Foods")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("account-strip-line")).toHaveTextContent("Owes $0.00"),
    );
  });

  it("a credit-limit refusal offers Record payment for that customer; a payment clears the refusal", async () => {
    mockCreateOrderError = creditRefusal;
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer("Acme Foods");
    const banner = await screen.findByText(/over their \$100\.00 credit limit/);
    const action = within(
      banner.closest("[data-testid='credit-refusal']") as HTMLElement,
    ).getByRole("button", { name: "Record payment" });
    await user.click(action);
    expect(modalProps?.customerId).toBe("c1");
    expect(modalProps?.focusInvoiceId).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "stub-pay" }));
    expect(createOrderReset).toHaveBeenCalled();
  });

  it("a role without payment rights sees no Record payment on the refusal and none on the strip", async () => {
    mockRole = "DRIVER";
    mockCreateOrderError = creditRefusal;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer("Acme Foods");
    await screen.findByText(/over their \$100\.00 credit limit/);
    await screen.findByTestId("account-strip-line");
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
  });
});
