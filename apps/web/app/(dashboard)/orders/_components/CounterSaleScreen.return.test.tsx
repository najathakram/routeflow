import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/** POS-4: the receipt mounts the "Return items" action for the sale's order. */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async () => ({
    product: { id: "p", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null },
    source: "sku",
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("./CounterReturnAction", () => ({
  CounterReturnAction: ({ orderId }: { orderId: string }) => (
    <button type="button">Return items for {orderId}</button>
  ),
}));

it("the receipt mounts the return action for the sale's order", async () => {
  window.print = jest.fn();
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 20,
    balanceDue: 0,
    change: 17.5,
    paymentRecorded: true,
  });
  renderWithProviders(<CounterSaleScreen />);
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "X" } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect(screen.getByText(/Cola/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "$20" }));
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
  await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Return items for o1" })).toBeInTheDocument();
  // POS-4b: the entry sits BETWEEN Print and New sale.
  const names = screen.getByTestId("counter-sale-receipt").querySelectorAll("button");
  const order = Array.from(names).map((b) => b.textContent);
  const print = order.indexOf("Print");
  const ret = order.indexOf("Return items for o1");
  const next = order.indexOf("New sale");
  expect(print).toBeGreaterThanOrEqual(0);
  expect(ret).toBe(print + 1);
  expect(next).toBe(ret + 1);
});
