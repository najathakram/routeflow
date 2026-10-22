import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import ReturnsPage from "./page";

/**
 * B1264: New Return can start from the number a customer holds. An order number (ORD-…) or invoice number (INV-…) finds the
 * sale, walk-in counter sale included, fills its customer + order and opens the same inline return flow.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/returns",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlSearch", () => ({
  useUrlSearch: () => ["", jest.fn(), ""],
}));
jest.mock("@/lib/hooks/useUrlPage", () => ({
  useUrlPage: () => [1, jest.fn()],
  useClampPage: () => undefined,
}));
jest.mock("@/lib/api/returns", () => ({
  useReturns: () => ({ data: { data: [], meta: { total: 0, totalPages: 1 } }, isLoading: false }),
  useCreateReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: {
      data: [
        { id: "c-acme", businessName: "Acme Deli" },
        { id: "c-beta", businessName: "Beta Mart" },
      ],
    },
  }),
}));

const WALKIN_ORDER = {
  id: "o-walk",
  orderNumber: "ORD-00001",
  customerId: "c-walk",
  customer: { id: "c-walk", businessName: "Walk-in", isWalkIn: true },
  status: "DELIVERED",
  lineItems: [],
};
const ACME_ORDER = {
  id: "o-acme",
  orderNumber: "ORD-00003",
  customerId: "c-acme",
  customer: { id: "c-acme", businessName: "Acme Deli" },
  status: "DELIVERED",
  lineItems: [],
};
const PENDING_ORDER = {
  ...WALKIN_ORDER,
  id: "o-pend",
  orderNumber: "ORD-00002",
  status: "PENDING",
};
let mockAddon = true;
const mockUseOrders = jest.fn();
jest.mock("@/lib/api/orders", () => ({
  useOrders: (...a: unknown[]) => mockUseOrders(...a),
  useOrder: (id: string) => ({
    data: [WALKIN_ORDER, PENDING_ORDER, ACME_ORDER].find((o) => o.id === id),
  }),
}));
const mockUseInvoices = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: (...a: unknown[]) => mockUseInvoices(...a),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => mockAddon }));
jest.mock("@/lib/api/addons", () => ({ ORDERS_INLINE_RETURNS_ADDON: "orders_inline_returns" }));
jest.mock("./_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: {
    open: boolean;
    customerId: string;
    orderId?: string;
    sourceOrderId?: string;
  }) =>
    p.open ? (
      <div data-testid="inline-return" data-customer={p.customerId} data-order={p.orderId}>
        inline return for {p.sourceOrderId}
      </div>
    ) : null,
}));

beforeEach(() => {
  mockAddon = true;
  mockUseOrders.mockReset();
  mockUseInvoices.mockReset();
  mockUseOrders.mockImplementation((params?: { search?: string }) => ({
    data: {
      data: [WALKIN_ORDER, PENDING_ORDER, ACME_ORDER].filter(
        (o) => o.orderNumber === params?.search?.toUpperCase(),
      ),
    },
    isLoading: false,
  }));
  mockUseInvoices.mockImplementation((params?: { search?: string }) => ({
    data: {
      data:
        params?.search?.toUpperCase() === "INV-00007"
          ? [{ id: "i1", invoiceNumber: "INV-00007", orderId: "o-walk" }]
          : [],
    },
  }));
});

async function openNewReturn() {
  renderWithProviders(<ReturnsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /new return|create return/i })[0]);
  return await screen.findByRole("dialog");
}

describe("New Return: find the sale by order or invoice number (B1264)", () => {
  it("an order number finds a walk-in counter sale and opens its return", async () => {
    await openNewReturn();
    fireEvent.change(screen.getByLabelText(/find by order or invoice number/i), {
      target: { value: "ORD-00001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const flow = await screen.findByTestId("inline-return");
    expect(flow).toHaveAttribute("data-customer", "c-walk");
    expect(flow).toHaveAttribute("data-order", "o-walk");
  });

  it("an invoice number finds the same sale", async () => {
    await openNewReturn();
    fireEvent.change(screen.getByLabelText(/find by order or invoice number/i), {
      target: { value: "INV-00007" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByTestId("inline-return")).toHaveAttribute("data-order", "o-walk");
  });

  it("an unknown number says so and opens nothing", async () => {
    await openNewReturn();
    fireEvent.change(screen.getByLabelText(/find by order or invoice number/i), {
      target: { value: "ORD-99999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() =>
      expect(screen.getByText(/No sale found for ORD-99999/)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("inline-return")).toBeNull();
  });

  it("the customer-first path is still there", async () => {
    await openNewReturn();
    expect(screen.getByRole("option", { name: "Acme Deli" })).toBeInTheDocument();
    expect(screen.getByText("Select customer…")).toBeInTheDocument();
  });
});

const find = (n: string) => {
  fireEvent.change(screen.getByLabelText(/find by order or invoice number/i), {
    target: { value: n },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
};
const selects = () => screen.getAllByRole("combobox") as HTMLSelectElement[];
const customerSelect = () =>
  selects().find((s) => s.value === "" || s.querySelector("option[value='c-beta']"))!;
const orderSelect = () => selects().find((s) => s.textContent?.includes("delivered order"))!;

describe("New Return without the inline-returns add-on (M2, M3)", () => {
  beforeEach(() => {
    mockAddon = false;
  });

  it("M3: a walk-in sale found by number fills customer and order in the old form", async () => {
    await openNewReturn();
    find("ORD-00001");
    await waitFor(() => expect(orderSelect().value).toBe("o-walk"));
    expect(customerSelect().value).toBe("c-walk");
    expect(screen.queryByTestId("inline-return")).toBeNull();
  });

  it("M3: a sale that is not DELIVERED says so and is not injected", async () => {
    await openNewReturn();
    find("ORD-00002");
    expect(
      await screen.findByText(/This sale can't be returned yet \(status PENDING\)/),
    ).toBeInTheDocument();
    expect(customerSelect().value).toBe("");
    expect(orderSelect().value).toBe("");
  });

  it("M2: finding the already-selected customer's order sets it, and changing customer clears it", async () => {
    await openNewReturn();
    fireEvent.change(customerSelect(), { target: { value: "c-acme" } });
    find("ORD-00003");
    await waitFor(() => expect(orderSelect().value).toBe("o-acme"));
    fireEvent.change(customerSelect(), { target: { value: "c-beta" } });
    // no stale order id survives the change: submitting asks for an order
    fireEvent.click(screen.getByRole("button", { name: "Create Return" }));
    expect(await screen.findByText("Select an order.")).toBeInTheDocument();
  });
});
