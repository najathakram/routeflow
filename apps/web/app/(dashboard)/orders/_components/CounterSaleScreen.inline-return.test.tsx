import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-863 (SA-945 PR-1): the counter sale carries Create Order's inline return. The Returns section itself is Create Order's
 * (tested there); a stand-in drives its handle and quote total so this file proves the COUNTER glue: the quote gates Complete,
 * the credit nets against the tender, the request carries the return (one returnKey across a retry), a return worth more than
 * the sale shows the store credit left, and a walk-in is told returns are refunded.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const BIG = { id: "p-big", name: "Big", pricePerUnit: 10, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "BIG" ? { product: BIG, source: "sku" } : { notFound: true },
}));
// SA-1068: the till reads the customer's remembered prices (an empty, answered read here: no sticky upsell).
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

// The stand-in for Create Order's Returns section: a "Quote" button sets a quoted draft worth `quoteAmount`.
let quoteAmount = 4;
jest.mock("./OrderInlineReturnsSection", () => {
  const React = jest.requireActual("react");
  const Section = React.forwardRef(function Section(
    props: { onQuoteTotalChange?: (n: number) => void; refusalMessage?: string },
    ref: React.Ref<unknown>,
  ) {
    const [quoted, setQuoted] = React.useState(false);
    const [entered, setEntered] = React.useState(false);
    React.useImperativeHandle(ref, () => ({
      getDraft: () =>
        entered
          ? {
              lines: [
                {
                  productId: "p-snack",
                  productName: "Snack",
                  boxes: "0",
                  pieces: "1",
                  reason: "",
                  note: "",
                },
              ],
              captureReason: "DAMAGED",
              quoted,
            }
          : null,
      reset: () => {
        setEntered(false);
        setQuoted(false);
      },
      generation: () => 0,
    }));
    return (
      <div data-testid="returns-section">
        <button type="button" onClick={() => setEntered(true)}>
          Enter return line
        </button>
        <button
          type="button"
          onClick={() => {
            setQuoted(true);
            props.onQuoteTotalChange?.(quoteAmount);
          }}
        >
          Get return quote
        </button>
        {props.refusalMessage ? <p>{props.refusalMessage}</p> : null}
      </div>
    );
  });
  return { OrderInlineReturnsSection: Section };
});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  quoteAmount = 4;
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 10,
    paid: 10,
    balanceDue: 0,
    change: 0,
    paymentRecorded: true,
  });
});

const scan = async (text: string, name = "Big") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};
const pickAcme = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
};
const complete = () =>
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));

describe("CounterSaleScreen: an inline return rides the sale (W-863)", () => {
  it("a named customer sees the Returns section; a walk-in is told returns are refunded", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    expect(screen.getByTestId("returns-section")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-return-walkin-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    expect(screen.queryByTestId("returns-section")).toBeNull();
    expect(screen.getByTestId("counter-return-walkin-note")).toHaveTextContent("refunded");
  });

  it("a return that was not quoted blocks Complete and sends nothing", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "Enter return line" }));
    complete();
    expect(await screen.findByRole("alert")).toHaveTextContent("Get a quote for the return");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("the quoted credit nets against the amount due, and the request carries the return", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "Enter return line" }));
    fireEvent.click(screen.getByRole("button", { name: "Get return quote" }));
    expect(screen.getByTestId("change-due")).toHaveTextContent("Amount due $6.00");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$10.00");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "6" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.inlineReturn).toMatchObject({
      returnKey: expect.any(String),
      items: [{ productId: "p-snack", boxes: 0, pieces: 1 }],
    });
    expect(dto.payment).toMatchObject({ method: "CASH", amount: 6 });
  });

  it("a return worth more than the sale shows the store credit left, and nothing to pay", async () => {
    quoteAmount = 12;
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "Enter return line" }));
    fireEvent.click(screen.getByRole("button", { name: "Get return quote" }));
    expect(screen.getByTestId("change-due")).toHaveTextContent("Amount due $0.00");
    expect(screen.getByTestId("return-store-credit")).toHaveTextContent("Store credit $2.00");
  });

  it("a sale with no return is unchanged: no inlineReturn on the request, no store credit line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    expect(screen.queryByTestId("return-store-credit")).toBeNull();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.inlineReturn).toBeUndefined();
  });

  it("a retry of an attempt that got no answer resends the SAME returnKey", async () => {
    const offline = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    mutateAsync.mockRejectedValueOnce(offline);
    renderWithProviders(<CounterSaleScreen />);
    await scan("BIG");
    pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "Enter return line" }));
    fireEvent.click(screen.getByRole("button", { name: "Get return quote" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "6" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const first = mutateAsync.mock.calls[0][0];
    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    const second = mutateAsync.mock.calls[1][0];
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.dto.inlineReturn.returnKey).toBe(first.dto.inlineReturn.returnKey);
  });
});
