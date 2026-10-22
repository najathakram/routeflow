import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_VOIDED_COPY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-18: a refusal shown in the checkout bar (a 409 "Something changed...") belongs to the cart that was refused. Editing the
 * cart (a scan, a quantity, a removal) makes it stale, so it goes; an unrelated tender change keeps its own rule.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 3, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA"
      ? { product: COLA, source: "sku" }
      : code === "WATER"
        ? { product: WATER, source: "sku" }
        : { notFound: true },
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

const CHANGED = /Something changed while you were checking out/;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockRejectedValue({ response: { status: 409 } });
});

const scan = async (text: string, name = "Cola") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};
const refused = async () => {
  await scan("COLA");
  fireEvent.click(screen.getByRole("button", { name: "$20" }));
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(CHANGED);
};

describe("CounterSaleScreen: a refusal goes when the cart changes (CQ-18)", () => {
  it("scanning another item clears it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await refused();
    await scan("WATER", "Water");
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
  });

  it("stepping a quantity clears it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await refused();
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" }));
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
  });

  it("removing the line clears it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await refused();
    fireEvent.click(screen.getByRole("button", { name: "Remove Cola" }));
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
  });

  it("a FINAL message (the sale was voided) stays when the cart is edited", async () => {
    mutateAsync.mockRejectedValue({
      response: { status: 409, data: { code: API_ERROR_CODES.COUNTER_SALE_VOIDED } },
    });
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(COUNTER_SALE_VOIDED_COPY);
    await scan("WATER", "Water");
    expect(screen.getByRole("alert")).toHaveTextContent(COUNTER_SALE_VOIDED_COPY);
  });

  it("without an edit the refusal stays put", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await refused();
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    expect(screen.getByRole("alert")).toHaveTextContent(CHANGED);
  });
});
