import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/** R7b 1.2: one keyboard path to pay. Enter in an empty scan box moves to the payment; the tender methods are a radiogroup. */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const CRATE = {
  id: "p-crate",
  name: "Crate",
  pricePerUnit: 17.22,
  unit: "each",
  unitsPerBox: null,
};
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "c1", businessName: "Acme Co", pricingTier: 1 }] } }),
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
  orderNumber: "ORD-1042",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 20,
  balanceDue: 0,
  change: 17.5,
  paymentRecorded: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockResolvedValue(SALE);
});

const scan = async (text: string, name = "Cola") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};

let clock = 1000;
beforeEach(() => {
  clock = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());
/** Enter in the empty scan box, a person's pause (200 ms) after the last scan activity unless `after` says otherwise. */
const pressEnterInScan = (after = 200) => {
  clock += after;
  fireEvent.keyDown(screen.getByLabelText("Scan or search items"), { key: "Enter" });
};

describe("CounterSaleScreen: keyboard path to pay (R7b 1.2)", () => {
  it("Enter on an empty scan box with lines focuses Amount tendered (cash)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    pressEnterInScan();
    await waitFor(() => expect(screen.getByLabelText("Amount tendered")).toHaveFocus());
  });

  it("Enter on an empty scan box with lines focuses Complete & show receipt for card", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    pressEnterInScan();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Complete & show receipt" })).toHaveFocus(),
    );
  });

  it("Enter on an empty scan box with no lines does nothing", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const field = screen.getByLabelText("Scan or search items");
    field.focus();
    pressEnterInScan();
    await new Promise((r) => setTimeout(r, 20));
    expect(field).toHaveFocus();
  });

  it("keyboard only: scan, Enter, type the tender, Enter completes the sale", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    pressEnterInScan();
    const tender = await screen.findByLabelText("Amount tendered");
    await waitFor(() => expect(tender).toHaveFocus());
    fireEvent.change(tender, { target: { value: "20" } });
    fireEvent.keyDown(tender, { key: "Enter" });
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("an Enter 20 ms after a scan submit does not move focus; one 200 ms after does", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const field = screen.getByLabelText("Scan or search items");
    field.focus();
    pressEnterInScan(20); // a scanner's CR+LF tail
    await new Promise((r) => setTimeout(r, 20));
    expect(field).toHaveFocus();
    pressEnterInScan(200);
    await waitFor(() => expect(screen.getByLabelText("Amount tendered")).toHaveFocus());
  });

  it("arrow keys move between tender methods", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const group = screen.getByRole("radiogroup", { name: "Payment method" });
    expect(group).toBeInTheDocument();
    const cash = screen.getByRole("radio", { name: "Cash" });
    expect(cash).toHaveAttribute("aria-checked", "true");
    cash.focus();
    fireEvent.keyDown(cash, { key: "ArrowRight" });
    const card = screen.getByRole("radio", { name: "Card" });
    expect(card).toHaveAttribute("aria-checked", "true");
    expect(card).toHaveFocus();
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
  });

  it("the tender group keeps one enabled tab stop after a walk-in switch disables the checked method", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    expect(screen.getByRole("radio", { name: "On account" })).toBeDisabled();
    const stops = screen.getAllByRole("radio").filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeEnabled();
    expect(stops[0]).toHaveAccessibleName("Cash");
  });
});
