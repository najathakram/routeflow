import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import ReturnsPage from "./page";

/**
 * REG-B1: the inline capture/refund flow (RecordInlineReturnDialog, opened when New Return finds a sale by number) is
 * staff-only in the API. A CUSTOMER who finds a sale never gets it; the plain New Return form stays.
 * Harness as page.test.tsx, plus a seeded session.
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
  useCustomers: () => ({ data: { data: [{ id: "c-acme", businessName: "Acme Deli" }] } }),
}));
const ACME_ORDER = {
  id: "o-acme",
  orderNumber: "ORD-00003",
  customerId: "c-acme",
  customer: { id: "c-acme", businessName: "Acme Deli" },
  status: "DELIVERED",
  lineItems: [],
};
jest.mock("@/lib/api/orders", () => ({
  useOrders: (params?: { search?: string }) => ({
    data: { data: params?.search?.toUpperCase() === "ORD-00003" ? [ACME_ORDER] : [] },
    isLoading: false,
  }),
  useOrder: (id: string) => ({ data: id === "o-acme" ? ACME_ORDER : undefined }),
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
jest.mock("@/lib/api/addons", () => ({ ORDERS_INLINE_RETURNS_ADDON: "orders_inline_returns" }));
jest.mock("./_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: { open: boolean; sourceOrderId?: string }) =>
    p.open ? <div data-testid="inline-return">inline return for {p.sourceOrderId}</div> : null,
}));

afterEach(() => seedSession(null));

async function findSale() {
  renderWithProviders(<ReturnsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /new return|create return/i })[0]);
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText(/find by order or invoice number/i), {
    target: { value: "ORD-00003" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
}

describe("REG-B1 returns list inline refund flow by role", () => {
  it("REG-B1 a CUSTOMER who finds a sale gets no inline refund dialog", async () => {
    seedSession("CUSTOMER");
    await findSale();
    await new Promise((r) => setTimeout(r, 50));
    expect({
      label: "inline return dialog",
      count: screen.queryAllByTestId("inline-return").length,
    }).toEqual({ label: "inline return dialog", count: 0 });
  });

  it("REG-B1 an OPERATOR twin who finds a sale gets the inline return dialog", async () => {
    seedSession("OPERATOR");
    await findSale();
    await waitFor(() => expect(screen.getAllByTestId("inline-return").length).toBeGreaterThan(0));
  });

  const waitingChip = () =>
    screen.queryAllByRole("button", { name: "Waiting for approval" }).length;

  it("REG-B1 a CUSTOMER sees no Waiting for approval chip", () => {
    seedSession("CUSTOMER");
    renderWithProviders(<ReturnsPage />);
    expect({ label: "Waiting for approval chip", count: waitingChip() }).toEqual({
      label: "Waiting for approval chip",
      count: 0,
    });
  });

  it("REG-B1 an OPERATOR twin sees the Waiting for approval chip", () => {
    seedSession("OPERATOR");
    renderWithProviders(<ReturnsPage />);
    expect({ label: "Waiting for approval chip", count: waitingChip() >= 1 }).toEqual({
      label: "Waiting for approval chip",
      count: true,
    });
  });
});
