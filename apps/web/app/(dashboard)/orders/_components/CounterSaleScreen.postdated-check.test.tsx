import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { tenantDayIn } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Interim till guard: the Check fields are CounterCheckDetails, the request carries checkDate, and a check dated after the
 * business's today is refused client-side with the one sentence (Complete is not disabled: the bar's own alert says why).
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
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
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0, timezone: "UTC" } }),
    post: jest.fn(),
  },
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

const SENTENCE = "Post-dated check: put this sale on account and record the check when it clears.";
const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1042",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 2.5,
  balanceDue: 0,
  paymentRecorded: true,
};
const dayPlus = (n: number) => {
  const d = new Date(`${tenantDayIn("UTC")}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
const chooseCheck = async () => {
  fireEvent.click(screen.getByRole("radio", { name: "Check" }));
  // the tenant day is known once the settings read lands: the date then defaults to today
  await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
  fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
};

describe("CounterSaleScreen: post-dated check", () => {
  it("a check defaults to the business's today: no message, and the sale carries that checkDate", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({
      method: "CHECK",
      reference: "1042",
      checkDate: dayPlus(0),
    });
  });

  it("an earlier date is tendered with that date", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(-3) } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe(dayPlus(-3));
  });

  it("a future date shows the sentence; Complete is refused with it and nothing is sent", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
    expect(screen.getByTestId("counter-check-postdated")).toHaveTextContent(SENTENCE);
    const complete = screen.getByRole("button", { name: "Complete & show receipt" });
    expect(complete).toBeEnabled(); // the guard is in complete(), not on the button
    fireEvent.click(complete);
    await waitFor(() =>
      expect(screen.getAllByRole("alert").some((a) => a.textContent === SENTENCE)).toBe(true),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Check" })).toHaveAttribute("aria-checked", "true");
  });

  it("a walk-in cannot put it on account: the button is disabled", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
    expect(screen.getByRole("button", { name: "Put this sale on account" })).toBeDisabled();
  });

  it("a named customer: Put this sale on account switches the tender, hides the check fields, and sells on account with no checkDate", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(2) } });
    fireEvent.click(screen.getByRole("button", { name: "Put this sale on account" }));
    expect(screen.getByRole("radio", { name: "On account" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByLabelText("Check date")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    const payment = mutateAsync.mock.calls[0][0].dto.payment;
    expect(payment.method).toBe("ON_ACCOUNT");
    expect(payment).not.toHaveProperty("checkDate");
  });

  it("a new sale starts with a fresh date: the previous sale's date does not carry over", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(-1) } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & next sale" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await scan("COLA");
    await chooseCheck(); // asserts the date is back to today
  });
});
