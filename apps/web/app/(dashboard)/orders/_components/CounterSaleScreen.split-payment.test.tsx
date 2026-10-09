import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Split payment on the counter screen. The API is mocked at the module boundary (the same harness as CounterSaleScreen.test).
 * Pins: (1) the plain single-tender controls are all still there, and come back after "Back to single payment";
 * (2) the panel's states: walk-in short, exact, over with cash change, card + cash, a check without its number, the 5th
 * line refused, On account alone, removing a line, a named customer's rest left on account; (3) the wire body carries
 * `payments` (never `payment` too) with an explicit amount per leg; (4) a held attempt replays the exact legs, same key.
 */

const authUser = { id: "u-a", tenantSlug: "acme" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: authUser }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const BIG = { id: "p-big", name: "Big Order", pricePerUnit: 70, unit: "each", unitsPerBox: null };
let productFor: Record<string, unknown> = {};
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
}));
let customersFor: unknown[] = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: customersFor } }),
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
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
const lookupAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: lookupAsync, isPending: false }),
}));

const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 70,
  paid: 70,
  balanceDue: 0,
  change: 10,
  paymentRecorded: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  customersFor = [];
  productFor = { COLA, BIG };
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["PICKUP", "SHIP"] },
  };
  mutateAsync.mockResolvedValue(SALE);
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const ring70 = async () => {
  renderWithProviders(<CounterSaleScreen />);
  await scan("BIG");
  await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$70.00"));
};
const openSplit = () => fireEvent.click(screen.getByRole("button", { name: "Split payment" }));
const setAmount = (n: number, v: string) =>
  fireEvent.change(screen.getByLabelText(`Payment ${n} amount`), { target: { value: v } });
const setMethod = (n: number, v: string) =>
  fireEvent.change(screen.getByLabelText(`Payment ${n} method`), { target: { value: v } });
const complete = () => screen.getByRole("button", { name: "Complete & show receipt" });

describe("the existing counter controls are all still there (nothing lost)", () => {
  it("single tender: every control is present, and the split link sits after them", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    for (const name of ["Cash", "Card", "Check", "Exact", "$20", "$50", "$100"])
      expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(screen.getByRole("button", { name: "On account" })).toBeDisabled(); // a walk-in
    expect(screen.getByLabelText("Amount tendered")).toBeInTheDocument();
    expect(screen.getByTestId("change-due")).toBeInTheDocument();
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.getByLabelText("Find a customer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Print receipt automatically" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ship this order instead" })).toBeInTheDocument();
    expect(complete()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Complete & next sale/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split payment" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByLabelText("Check number")).toBeInTheDocument();
  });

  it("the plain single tender is byte-for-byte what it was: `payment`, no `payments`", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.payment).toEqual({ method: "CASH", amount: 20 });
    expect(dto).not.toHaveProperty("payments");
  });

  it("opening the split hides the single method / tender controls; Back restores them with the sale intact", async () => {
    await ring70();
    openSplit();
    expect(screen.getByTestId("split-tender-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Card" })).toBeNull();
    expect(screen.queryByLabelText("Amount tendered")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split payment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to single payment" }));
    for (const name of ["Cash", "Card", "Check", "Split payment"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByLabelText("Amount tendered")).toBeInTheDocument();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$70.00");
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.payment).toEqual({ method: "CASH", amount: 70 });
    expect(dto).not.toHaveProperty("payments");
  });
});

describe("the split panel, walk-in", () => {
  it("opens with two lines (cash, card) and the whole total remaining; Complete is off", async () => {
    await ring70();
    openSplit();
    expect(screen.getByLabelText("Payment 1 method")).toHaveValue("CASH");
    expect(screen.getByLabelText("Payment 2 method")).toHaveValue("CARD");
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$70.00");
    expect(complete()).toBeDisabled();
  });

  it("short: Remaining shows the rest, Complete stays off, nothing is posted", async () => {
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "20");
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$20.00");
    expect(screen.getByTestId("split-problem")).toHaveTextContent(
      "A walk-in customer must pay the full balance.",
    );
    expect(complete()).toBeDisabled();
    fireEvent.click(complete());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("exact: Remaining $0.00, Complete on, the body carries payments with an amount per leg and NO payment", async () => {
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "40");
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$0.00");
    expect(screen.queryByTestId("split-change")).toBeNull();
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      dto: {
        walkIn: true,
        items: [{ productId: "p-big", qty: 1 }],
        payments: [
          { method: "CASH", amount: 40 },
          { method: "CARD", amount: 30 },
        ],
      },
      idempotencyKey: "key-1",
    });
  });

  it("over with cash: card 30 + cash 50 on 70 shows Change $10.00 LARGE and posts the cash as handed over", async () => {
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "50");
    expect(screen.getByTestId("split-change")).toHaveTextContent("Change $10.00");
    expect(screen.getByTestId("split-change").className).toMatch(/text-3xl/);
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$0.00");
    fireEvent.click(complete());
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(mutateAsync.mock.calls[0][0].dto.payments).toEqual([
      { method: "CASH", amount: 50 },
      { method: "CARD", amount: 30 },
    ]);
  });

  it("the cash line's Exact fills what the OTHER lines left; a bill below that is off", async () => {
    await ring70();
    openSplit();
    setAmount(2, "30");
    expect(screen.getByRole("button", { name: "Cash $20" })).toBeDisabled(); // 20 < 40 still due
    expect(screen.getByRole("button", { name: "Cash $50" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cash Exact" }));
    expect(screen.getByLabelText("Payment 1 amount")).toHaveValue("40");
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$0.00");
  });

  it("a card above the total is refused (the sale cannot be completed)", async () => {
    await ring70();
    openSplit();
    setAmount(2, "80");
    setAmount(1, "5");
    expect(screen.getByTestId("split-problem")).toHaveTextContent("add up to more than");
    expect(complete()).toBeDisabled();
  });

  it("a check line asks for its number; Complete waits for it and the number goes on the leg", async () => {
    await ring70();
    openSplit();
    setMethod(2, "CHECK");
    setAmount(2, "30");
    setAmount(1, "40");
    expect(screen.getByLabelText("Payment 2 check number")).toBeInTheDocument();
    expect(screen.getByTestId("split-problem")).toHaveTextContent("Enter the check number.");
    expect(complete()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Payment 2 check number"), {
      target: { value: "1042" },
    });
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.payments).toEqual([
      { method: "CASH", amount: 40 },
      { method: "CHECK", amount: 30, reference: "1042" },
    ]);
  });

  it("one cash line: Cash is not offered on a second line", async () => {
    await ring70();
    openSplit();
    const opt = within(screen.getByLabelText("Payment 2 method")).getByRole("option", {
      name: "Cash",
    }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
  });

  it("the 5th line is refused: Add payment goes off at four lines", async () => {
    await ring70();
    openSplit();
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    expect(screen.getByLabelText("Payment 4 amount")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add payment" })).toBeDisabled();
    expect(screen.getByTestId("split-max-legs")).toHaveTextContent("Up to 4 payments");
    expect(screen.queryByLabelText("Payment 5 amount")).toBeNull();
  });

  it("remove a line: three lines back to two; at two, Remove is off", async () => {
    await ring70();
    openSplit();
    expect(screen.getByRole("button", { name: "Remove payment 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    expect(screen.getByLabelText("Payment 3 amount")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove payment 3" }));
    expect(screen.queryByLabelText("Payment 3 amount")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove payment 1" })).toBeDisabled();
  });

  it("On account is not pickable on a split line", async () => {
    await ring70();
    openSplit();
    const opt = within(screen.getByLabelText("Payment 1 method")).getByRole("option", {
      name: "On account",
    }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
  });
});

describe("the split panel, named customer", () => {
  const pickAcme = async () => {
    customersFor = [{ id: "c1", businessName: "Acme Co", fulfillPath: "PICKUP" }];
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(await screen.findByRole("button", { name: "Acme Co" }));
  };

  it("pays part now: the rest is shown as left on account and Complete is on", async () => {
    await ring70();
    await pickAcme();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "10");
    expect(screen.getByTestId("split-remaining")).toHaveTextContent("$30.00");
    expect(screen.getByTestId("split-on-account")).toHaveTextContent(/Left on account\s*\$30\.00/);
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto).toMatchObject({
      customerId: "c1",
      payments: [
        { method: "CASH", amount: 10 },
        { method: "CARD", amount: 30 },
      ],
    });
  });

  it("On account stays a plain single tender (alone) and opening the split never starts on it", async () => {
    await ring70();
    await pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "On account" }));
    openSplit();
    expect(screen.getByLabelText("Payment 1 method")).toHaveValue("CARD");
    const opt = within(screen.getByLabelText("Payment 2 method")).getByRole("option", {
      name: "On account",
    }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
  });
});

describe("a held attempt replays the exact legs with the same key", () => {
  it("after an unknown outcome the panel is frozen, Try again re-sends the SAME body and key, and a reload restores the legs", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    const view = await (async () => {
      const v = renderWithProviders(<CounterSaleScreen />);
      await scan("BIG");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$70.00"));
      return v;
    })();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "50");
    fireEvent.click(complete());
    await screen.findByTestId("counter-outcome-unknown");
    expect(screen.getByLabelText("Payment 1 amount")).toBeDisabled();
    expect(screen.getByLabelText("Payment 2 method")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add payment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back to single payment" })).toBeDisabled();

    // a reload: the held legs come back as the clerk rang them
    view.unmount();
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByTestId("counter-outcome-unknown");
    expect(screen.getByLabelText("Payment 1 amount")).toHaveValue("50");
    expect(screen.getByLabelText("Payment 2 amount")).toHaveValue("30");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0]).toEqual(mutateAsync.mock.calls[0][0]);
    expect(mutateAsync.mock.calls[1][0].idempotencyKey).toBe("key-1");
    expect(mutateAsync.mock.calls[1][0].dto.payments).toEqual([
      { method: "CASH", amount: 50 },
      { method: "CARD", amount: 30 },
    ]);
  });

  it("a recovered split sale (Check sale status) rings the cash leg as entered", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    lookupAsync.mockResolvedValueOnce({ ...SALE, method: "CASH", replayed: true });
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "50");
    fireEvent.click(complete());
    await screen.findByTestId("counter-outcome-unknown");
    fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(lookupAsync).toHaveBeenCalledWith({ idempotencyKey: "key-1", method: "CASH" });
  });

  it("a 409 COUNTER_TENDER_CHANGED is final: its fixed copy, the lock lifts, no retry", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_TENDER_CHANGED", message: "SERVER TEXT" } },
    });
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "40");
    fireEvent.click(complete());
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Part of this payment was already taken");
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(screen.queryByText(/SERVER TEXT/)).toBeNull();
  });

  it("a 400 pre-write refusal shows its fixed copy and keeps the legs editable", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 400, data: { code: "COUNTER_LEG_NOT_CENTS", message: "SERVER TEXT" } },
    });
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "40");
    fireEvent.click(complete());
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Amounts must be in dollars and cents");
    expect(screen.getByLabelText("Payment 1 amount")).toBeEnabled();
  });
});

describe("the receipt of a split sale", () => {
  it("lists each tender line and the change the server returned", async () => {
    mutateAsync.mockResolvedValueOnce({
      ...SALE,
      method: "CARD",
      change: 10,
      payments: [
        { method: "CARD", amount: 30, paymentIds: ["p1"] },
        { method: "CASH", amount: 40, paymentIds: ["p2"] },
      ],
    });
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "50");
    fireEvent.click(complete());
    await screen.findByTestId("counter-sale-receipt");
    const lines = screen.getAllByTestId("receipt-tender-line");
    expect(lines.map((l) => l.textContent)).toEqual(["Card$30.00", "Cash$40.00"]);
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("$10.00");
    expect(screen.getByTestId("receipt-tendered")).toHaveTextContent("$50.00");
    expect(screen.queryByTestId("receipt-method")).toBeNull();
  });

  it("paymentRecorded false (COUNTER_PAYMENT_EXCEEDS_TOTAL): the sale is kept, the fixed copy says to take the payment again", async () => {
    mutateAsync.mockResolvedValueOnce({
      ...SALE,
      paid: 0,
      balanceDue: 70,
      change: undefined,
      paymentRecorded: false,
      paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    });
    await ring70();
    openSplit();
    setAmount(2, "30");
    setAmount(1, "40");
    fireEvent.click(complete());
    await screen.findByTestId("counter-payment-not-recorded");
    expect(screen.getByTestId("counter-payment-not-recorded-why")).toHaveTextContent(
      "The balance changed — take the payment again",
    );
    expect(screen.getByRole("link", { name: "Record payment" })).toHaveAttribute(
      "href",
      "/invoices/i1",
    );
    expect(screen.queryAllByTestId("receipt-tender-line")).toHaveLength(0);
  });
});
