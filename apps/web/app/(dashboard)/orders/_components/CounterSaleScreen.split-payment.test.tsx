import * as React from "react";
import { isWholeCents } from "@routeflow/pricing";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Split payment on the counter screen, to the UX lane's G7 brief. The API is mocked at the module boundary (the same harness
 * as CounterSaleScreen.test). Pins: (1) the plain single-tender controls are all still there, the link shows only with lines,
 * and "Pay one way" brings them back; (2) the lines grow in place (Card first, then Cash) and the checkout bar's change-due slot
 * reads Remaining -> Change; (3) each inline line is the brief's string and nothing is posted while a rule holds; (4) the wire
 * body carries `payments` (never `payment` too) in the clerk's order; (5) a held attempt replays the exact legs, same key.
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
const pickMethod = (n: number, name: string) =>
  fireEvent.click(
    within(screen.getByRole("group", { name: `Payment ${n} method` })).getByRole("button", {
      name,
    }),
  );
const complete = () => screen.getByRole("button", { name: "Complete & show receipt" });
const slot = () => screen.getByTestId("change-due");
const enter = (n: number) =>
  fireEvent.keyDown(screen.getByLabelText(`Payment ${n} amount`), { key: "Enter" });

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

  it("the Split payment link needs a cart with lines, and is one full-width 44 px row", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByRole("button", { name: "Split payment" })).toBeNull();
    await scan("COLA");
    const link = await screen.findByRole("button", { name: "Split payment" });
    expect(link.className).toMatch(/\bw-full\b/);
    expect(link.className).toMatch(/min-h-\[44px\]|min-h-11/);
    expect(link).toHaveAttribute("data-testid", "split-payment-link");
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

  it("opening the split grows in place (no dialog), hides the single controls; Pay one way restores them, sale intact", async () => {
    await ring70();
    openSplit();
    expect(screen.getByTestId("split-tender-panel")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Amount tendered")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split payment" })).toBeNull();
    setAmount(1, "30");
    fireEvent.click(screen.getByRole("button", { name: "Pay one way" }));
    // the first line was Card: Card stays chosen and every amount is cleared
    expect(screen.getByRole("button", { name: "Card" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Cash", "Check", "Split payment"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByTestId("split-tender-panel")).toBeNull();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$70.00");
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    expect(screen.getByLabelText("Amount tendered")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.payment).toEqual({ method: "CASH", amount: 70 });
    expect(dto).not.toHaveProperty("payments");
  });

  it("Pay one way keeps the FIRST line's method even after it was changed", async () => {
    await ring70();
    openSplit();
    pickMethod(1, "Check");
    fireEvent.click(screen.getByRole("button", { name: "Pay one way" }));
    expect(screen.getByRole("button", { name: "Check" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Check number")).toBeInTheDocument();
  });
});

describe("the split lines, walk-in", () => {
  it("opens with Card then Cash, no amounts: the bar reads Remaining $70.00 and Complete is off, with no error shown", async () => {
    await ring70();
    openSplit();
    const card = within(screen.getByRole("group", { name: "Payment 1 method" }));
    const cash = within(screen.getByRole("group", { name: "Payment 2 method" }));
    expect(card.getByRole("button", { name: "Card" })).toHaveAttribute("aria-pressed", "true");
    expect(cash.getByRole("button", { name: "Cash" })).toHaveAttribute("aria-pressed", "true");
    expect(slot()).toHaveTextContent("Remaining $70.00");
    expect(complete()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Payment 1 amount")).toHaveFocus());
  });

  it("$70 with Card 30 + Cash 50: bar Change $10.00, ONE 201 with two legs in the clerk's order, receipt Card / Cash / Change", async () => {
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
    setAmount(1, "30");
    expect(slot()).toHaveTextContent("Remaining $40.00");
    setAmount(2, "50");
    expect(slot()).toHaveTextContent("Change $10.00");
    expect(slot().className).toMatch(/text-3xl/);
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({
      dto: {
        walkIn: true,
        items: [{ productId: "p-big", qty: 1 }],
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 50 },
        ],
      },
      idempotencyKey: "key-1",
    });
    expect(screen.getAllByTestId("receipt-tender-line").map((l) => l.textContent)).toEqual([
      "Card$30.00",
      "Cash$50.00",
    ]);
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("Change$10.00");
    expect(screen.getByTestId("receipt-method")).toHaveTextContent("Card + Cash");
    expect(screen.queryByTestId("receipt-tendered")).toBeNull();
  });

  it("exact: the bar reads Change $0.00 (never a dash) and the body carries no `payment`", async () => {
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "40");
    expect(slot()).toHaveTextContent("Change $0.00");
    expect(slot().textContent).not.toMatch(/[-—–]/);
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto).not.toHaveProperty("payment");
  });

  it("legs keep the clerk's order: Cash first then Card is sent Cash first", async () => {
    await ring70();
    openSplit();
    pickMethod(2, "Check"); // frees the one cash line
    pickMethod(1, "Cash");
    pickMethod(2, "Card");
    setAmount(1, "40");
    setAmount(2, "30");
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.payments).toEqual([
      { method: "CASH", amount: 40 },
      { method: "CARD", amount: 30 },
    ]);
  });

  it("short: Remaining shows the rest, Complete stays off, nothing is posted; Enter on the last line says '$12.00 is still due.'", async () => {
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "28");
    expect(slot()).toHaveTextContent("Remaining $12.00");
    expect(complete()).toBeDisabled();
    fireEvent.click(complete());
    expect(screen.queryByTestId("split-issue-2")).toBeNull(); // waits for an attempt
    enter(2);
    expect(within(screen.getByTestId("split-leg-2")).getByRole("alert")).toHaveTextContent(
      "$12.00 is still due.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    setAmount(2, "40");
    expect(screen.queryByTestId("split-issue-2")).toBeNull();
    expect(complete()).toBeEnabled();
  });

  it("Card 80 on $70 is refused inline under the card line, at once, with 0 POSTs", async () => {
    await ring70();
    openSplit();
    setAmount(1, "80");
    expect(within(screen.getByTestId("split-leg-1")).getByRole("alert")).toHaveTextContent(
      "Card and check can't be more than the total.",
    );
    expect(complete()).toBeDisabled();
    enter(1);
    enter(2);
    fireEvent.click(complete());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("a three-decimal amount is refused inline: 'Enter the amount in dollars and cents.'", async () => {
    await ring70();
    openSplit();
    setAmount(1, "12.345");
    expect(screen.getByTestId("split-issue-1")).toHaveTextContent(
      "Enter the amount in dollars and cents.",
    );
    expect(complete()).toBeDisabled();
  });

  it("a cash line gets only Exact / $20 / $50 / $100; Exact is what is still due and a smaller bill is off", async () => {
    await ring70();
    openSplit();
    expect(screen.queryByTestId("split-quick-cash-1")).toBeNull(); // the card line has none
    const q = within(screen.getByTestId("split-quick-cash-2"));
    expect(q.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Exact",
      "$20",
      "$50",
      "$100",
    ]);
    setAmount(1, "30");
    expect(q.getByRole("button", { name: "Cash $20" })).toBeDisabled(); // 20 < 40 still due
    expect(q.getByRole("button", { name: "Cash $50" })).toBeEnabled();
    fireEvent.click(q.getByRole("button", { name: "Cash Exact" }));
    expect(screen.getByLabelText("Payment 2 amount")).toHaveValue("40");
    expect(slot()).toHaveTextContent("Change $0.00");
  });

  it("a check line needs its number: Complete waits, Enter says so, and the number goes on the leg", async () => {
    await ring70();
    openSplit();
    pickMethod(2, "Check");
    expect(screen.queryByTestId("split-quick-cash-2")).toBeNull();
    setAmount(1, "30");
    setAmount(2, "40");
    expect(screen.getByLabelText("Payment 2 check number")).toBeInTheDocument();
    expect(complete()).toBeDisabled();
    enter(2);
    expect(screen.getByTestId("split-issue-2")).toHaveTextContent("Enter the check number.");
    fireEvent.change(screen.getByLabelText("Payment 2 check number"), {
      target: { value: "1042" },
    });
    expect(screen.queryByTestId("split-issue-2")).toBeNull();
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.payments).toEqual([
      { method: "CARD", amount: 30 },
      { method: "CHECK", amount: 40, reference: "1042" },
    ]);
  });

  it("one cash line: Cash is off on the other line; there is no On account anywhere in a split", async () => {
    await ring70();
    openSplit();
    const g1 = within(screen.getByRole("group", { name: "Payment 1 method" }));
    expect(g1.getByRole("button", { name: "Cash" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "On account" })).toBeNull();
  });

  it("Add payment sits under the last line up to four, then is hidden; it is hidden once nothing remains", async () => {
    await ring70();
    openSplit();
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    expect(screen.getByLabelText("Payment 4 amount")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add payment" })).toBeNull();
    expect(screen.queryByLabelText("Payment 5 amount")).toBeNull();
    expect(screen.queryByText(/Up to 4 payments/)).toBeNull(); // hidden, not explained
    // covered: nothing left to add
    fireEvent.click(screen.getByRole("button", { name: "Remove payment 4" }));
    setAmount(1, "70");
    expect(slot()).toHaveTextContent("Change $0.00");
    expect(screen.queryByRole("button", { name: "Add payment" })).toBeNull();
  });

  it("the x shows with two or more lines, removes its line, and is gone at one", async () => {
    await ring70();
    openSplit();
    expect(screen.getByRole("button", { name: "Remove payment 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add payment" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove payment 3" }));
    expect(screen.queryByLabelText("Payment 3 amount")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove payment 2" }));
    expect(screen.queryByRole("button", { name: /Remove payment/ })).toBeNull();
    expect(screen.getByLabelText("Payment 1 amount")).toBeInTheDocument();
  });

  it("an empty line is not sent: Card 70 with the cash line left blank is ONE leg", async () => {
    await ring70();
    openSplit();
    setAmount(1, "70");
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.payments).toEqual([{ method: "CARD", amount: 70 }]);
  });

  it("Enter moves to the next line, then completes ONCE when covered", async () => {
    await ring70();
    openSplit();
    await waitFor(() => expect(screen.getByLabelText("Payment 1 amount")).toHaveFocus());
    setAmount(1, "30");
    enter(1);
    await waitFor(() => expect(screen.getByLabelText("Payment 2 amount")).toHaveFocus());
    setAmount(2, "40");
    enter(2);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it("Enter completes at once when the first line already covers the sale", async () => {
    await ring70();
    openSplit();
    setAmount(1, "70");
    enter(1);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it("each amount input scrolls clear of the sticky checkout bar", async () => {
    await ring70();
    openSplit();
    expect(screen.getByTestId("counter-checkout-bar")).toBeInTheDocument();
    for (const n of [1, 2])
      expect(screen.getByLabelText(`Payment ${n} amount`).getAttribute("style")).toContain(
        "--counter-bar-h",
      );
  });
});

describe("the split lines, named customer", () => {
  const pickAcme = async () => {
    customersFor = [{ id: "c1", businessName: "Acme Co", fulfillPath: "PICKUP" }];
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(await screen.findByRole("button", { name: "Acme Co" }));
  };

  it("pays part now: Remaining stays in the bar, the rest is left on account and Complete is on", async () => {
    await ring70();
    await pickAcme();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "10");
    expect(slot()).toHaveTextContent("Remaining $30.00");
    expect(screen.getByTestId("split-on-account")).toHaveTextContent(/Left on account\s*\$30\.00/);
    expect(complete()).toBeEnabled();
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto).toMatchObject({
      customerId: "c1",
      payments: [
        { method: "CARD", amount: 30 },
        { method: "CASH", amount: 10 },
      ],
    });
  });

  it("On account stays a plain single tender (alone): a split opened from it starts on Card", async () => {
    await ring70();
    await pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "On account" }));
    openSplit();
    expect(
      within(screen.getByRole("group", { name: "Payment 1 method" })).getByRole("button", {
        name: "Card",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "On account" })).toBeNull();
  });
});

describe("the single tender never sends a sub-cent amount", () => {
  it("a tendered 20.005 goes out as a whole-cent figure", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "20.005" } });
    fireEvent.click(complete());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const amount = mutateAsync.mock.calls[0][0].dto.payment.amount;
    expect(isWholeCents(amount)).toBe(true);
  });
});

describe("a held attempt replays the exact legs with the same key", () => {
  it("after an unknown outcome the lines are frozen, Try again re-sends the SAME body and key, and a reload restores the legs", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    const view = await (async () => {
      const v = renderWithProviders(<CounterSaleScreen />);
      await scan("BIG");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$70.00"));
      return v;
    })();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "50");
    fireEvent.click(complete());
    await screen.findByTestId("counter-outcome-unknown");
    expect(screen.getByLabelText("Payment 1 amount")).toBeDisabled();
    expect(
      within(screen.getByRole("group", { name: "Payment 2 method" })).getByRole("button", {
        name: "Cash",
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add payment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pay one way" })).toBeDisabled();

    // a reload: the held legs come back as the clerk rang them
    view.unmount();
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByTestId("counter-outcome-unknown");
    expect(screen.getByLabelText("Payment 1 amount")).toHaveValue("30");
    expect(screen.getByLabelText("Payment 2 amount")).toHaveValue("50");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0]).toEqual(mutateAsync.mock.calls[0][0]);
    expect(mutateAsync.mock.calls[1][0].idempotencyKey).toBe("key-1");
    expect(mutateAsync.mock.calls[1][0].dto.payments).toEqual([
      { method: "CARD", amount: 30 },
      { method: "CASH", amount: 50 },
    ]);
  });

  it("a recovered split sale (Check sale status) shows the cash entered and the change, as entered", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    // GET by-key: the stored legs, never a change
    lookupAsync.mockResolvedValueOnce({
      ...SALE,
      change: undefined,
      method: "CARD",
      replayed: true,
      payments: [
        { method: "CARD", amount: 30, paymentIds: ["p1"] },
        { method: "CASH", amount: 40, paymentIds: ["p2"] },
      ],
    });
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "50");
    fireEvent.click(complete());
    await screen.findByTestId("counter-outcome-unknown");
    fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    // leg 0 of the held body is the CARD row: the lookup asks with that method
    expect(lookupAsync).toHaveBeenCalledWith({ idempotencyKey: "key-1", method: "CARD" });
    expect(screen.getAllByTestId("receipt-tender-line").map((l) => l.textContent)).toEqual([
      "Card$30.00",
      "Cash$50.00",
    ]);
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("$10.00");
    expect(screen.getByTestId("receipt-change")).toHaveTextContent("as entered");
  });

  it("a 409 COUNTER_TENDER_CHANGED is final: its fixed copy, the lock lifts, no retry", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_TENDER_CHANGED", message: "SERVER TEXT" } },
    });
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "40");
    fireEvent.click(complete());
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This sale was already paid a different way. Check recent sales.",
    );
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(screen.queryByText(/SERVER TEXT/)).toBeNull();
  });

  it("a 400 pre-write refusal shows its fixed copy and keeps the lines editable", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 400, data: { code: "COUNTER_LEG_NOT_CENTS", message: "SERVER TEXT" } },
    });
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "40");
    fireEvent.click(complete());
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the amount in dollars and cents.");
    expect(screen.getByLabelText("Payment 1 amount")).toBeEnabled();
  });
});

describe("the receipt of a split sale", () => {
  it("paymentRecorded false (COUNTER_PAYMENT_EXCEEDS_TOTAL): the sale is kept, the fixed copy says to take the payment again", async () => {
    mutateAsync.mockResolvedValueOnce({
      ...SALE,
      paid: 0,
      balanceDue: 70,
      change: undefined,
      paymentRecorded: false,
      paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      // all or nothing: the legs come back at amount 0 and nothing is recorded
      payments: [
        { method: "CARD", amount: 0, paymentIds: [] },
        { method: "CASH", amount: 0, paymentIds: [] },
      ],
    });
    await ring70();
    openSplit();
    setAmount(1, "30");
    setAmount(2, "40");
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
