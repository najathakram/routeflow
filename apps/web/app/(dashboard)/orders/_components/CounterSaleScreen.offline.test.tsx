import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-29: Complete pressed while the browser is OFFLINE. The request cannot have reached the server, so the screen says
 * "No connection. Nothing was charged yet..." in the checkout bar, the form is usable again (no unknown-outcome lock), and the
 * retry reuses the sale's Idempotency-Key. A network failure while the browser believed it was ONLINE stays an unknown outcome
 * (the request may have landed): the lock and banner of the existing contract, never "nothing was charged".
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

const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 2.5,
  balanceDue: 0,
  change: 0,
  paymentRecorded: true,
};
const COPY = "No connection. Nothing was charged yet. Check your connection and try again.";
const complete = () => screen.getByRole("button", { name: "Complete & show receipt" });
const keyOfCall = (i: number) => mutateAsync.mock.calls[i][0].idempotencyKey as string;

// `navigator.onLine` is a prototype getter; shadow it on the instance for the test and remove the shadow afterwards.
let online = true;
const setOnline = (v: boolean) => {
  online = v;
};
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});
afterEach(() => {
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
});

const scan = async (text: string, name = "Cola") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};
const ringCola = async () => {
  await scan("COLA");
  fireEvent.click(screen.getByRole("button", { name: "$20" }));
};

describe("CounterSaleScreen: offline at Complete (CQ-29)", () => {
  it("says there is no connection in the checkout bar and leaves the form usable", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    setOnline(false);
    fireEvent.click(complete());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(COPY);
    expect(screen.getByTestId("counter-checkout-bar")).toContainElement(alert);
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    // unfrozen: the scan field, the stepper-less cart and both Complete buttons all work again
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    expect(complete()).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Complete & next sale" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Cola" })).not.toBeDisabled();
  });

  it("the retry reuses the Idempotency-Key, even after the clerk changed the cart, and then succeeds", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    setOnline(false);
    fireEvent.click(complete());
    await screen.findByText(COPY);
    await scan("WATER", "Water"); // the form is not frozen: the clerk may still change the sale
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    setOnline(true);
    mutateAsync.mockResolvedValueOnce({ ...SALE, total: 5.5 });
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(keyOfCall(1)).toBe(keyOfCall(0));
    expect(mutateAsync.mock.calls[1][0].dto.items).toHaveLength(2);
    await screen.findByTestId("counter-sale-receipt");
  });

  it("the offline message clears when the next attempt starts", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    setOnline(false);
    fireEvent.click(complete());
    await screen.findByText(COPY);
    setOnline(true);
    mutateAsync.mockResolvedValueOnce(SALE);
    fireEvent.click(complete());
    await screen.findByTestId("counter-sale-receipt");
    expect(screen.queryByText(COPY)).toBeNull();
  });

  it("a network failure while the browser believed it was ONLINE stays an unknown outcome (locked, never 'nothing was charged')", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("Network Error"));
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    fireEvent.click(complete());
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    expect(screen.queryByText(/nothing was charged/i)).toBeNull();
    expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
  });

  it("offline with an answer (a 503) is still an unknown outcome", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    setOnline(false);
    fireEvent.click(complete());
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    expect(screen.queryByText(COPY)).toBeNull();
  });
});
