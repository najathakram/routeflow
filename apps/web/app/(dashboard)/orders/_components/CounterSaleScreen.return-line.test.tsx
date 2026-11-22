import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1211 A1.1 (VF-6): a $100 sale with a $40 return reads "Total $100.00 · Return −$40.00 · Amount due $60.00" on EVERY
 * tender, On account and Cash alike. All three figures are the counter's own (the figures Cash's "Amount due" reads); the
 * screen does no subtraction. A return worth more than the sale leaves "Credit" (A1.4: one word, never "Store credit").
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const BIG = { id: "p-big", name: "Big", pricePerUnit: 100, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "BIG" ? { product: BIG, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCustomerPriceHistory: () => ({
    data: {},
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
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
jest.mock("@/lib/api/tobacco", () => ({
  ...jest.requireActual("@/lib/api/tobacco"),
  useHasAddon: () => true,
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

// The stand-in for Create Order's Returns section: "Return quote answers" is the quote coming back, worth `quoteAmount`.
let quoteAmount = 40;
jest.mock("./OrderInlineReturnsSection", () => {
  const React = jest.requireActual("react");
  const Section = React.forwardRef(function Section(
    props: { onQuoteTotalChange?: (n: number) => void },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      getDraft: () => null,
      reset: () => undefined,
      generation: () => 0,
    }));
    return (
      <button type="button" onClick={() => props.onQuoteTotalChange?.(quoteAmount)}>
        Return quote answers
      </button>
    );
  });
  return { OrderInlineReturnsSection: Section };
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  quoteAmount = 40;
});

const LINE = "Total $100.00 · Return −$40.00 · Amount due $60.00";
const ready = async () => {
  renderWithProviders(<CounterSaleScreen />);
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "BIG" } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: "Remove Big" });
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
  fireEvent.click(screen.getByRole("button", { name: "Return quote answers" }));
};

describe("the counter return line (SA-1211 A1.1, VF-6)", () => {
  it("On account: $100 sale, $40 return reads Total, Return and Amount due", async () => {
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent(LINE);
  });

  it("Cash: the same sale reads the same line", async () => {
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent(LINE);
    expect(screen.getByTestId("change-due")).toHaveTextContent("Amount due $60.00");
  });

  it("Card: the same sale reads the same line", async () => {
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent(LINE);
  });

  it("a sale with no return keeps the plain Total, with no Return figure", async () => {
    quoteAmount = 0;
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent("$100.00");
    expect(screen.getByTestId("running-total")).not.toHaveTextContent("Return");
  });

  it("a return worth more than the sale leaves Credit, in the one word", async () => {
    quoteAmount = 120;
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent(
      "Total $100.00 · Return −$120.00 · Amount due $0.00",
    );
    expect(screen.getByTestId("return-store-credit")).toHaveTextContent("Credit $20.00");
    expect(screen.getByTestId("return-store-credit")).not.toHaveTextContent("Store credit");
  });
});
