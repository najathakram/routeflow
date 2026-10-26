import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { calendarDayInZone } from "@/lib/calendar-date";
import { PART_PAY_CREDIT_PENDING_COPY } from "@/lib/counter-part-pay";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-933 / W-822(a) S4: an identified customer pays part now (cash, check or card) and the rest goes on account. The request
 * carries `payment.amount` for the part (a FULL check or card payment still omits it), the bar says "Pay $X now · $Y goes on
 * account" while the tender is short, and a walk-in is still held to the full total.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const CASE = { id: "p-case", name: "Case", pricePerUnit: 12.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "CASE" ? { product: CASE, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: {
      data: [
        { id: "c-plain", businessName: "Plain Cafe", pricingTier: 1 },
        { id: "c-walkin", businessName: "Walk-in Record", pricingTier: 1, isWalkIn: true },
      ],
    },
  }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
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

const get = apiClient.get as unknown as jest.Mock;
const SPLIT = "Pay $5.00 now · $7.50 goes on account";
const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 12.5,
  paid: 5,
  balanceDue: 7.5,
  paymentRecorded: true,
};

let availableCredit: number | "pending" = 0;
beforeEach(() => {
  jest.clearAllMocks();
  availableCredit = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    if (/^\/customers\/[^/]+\/statement$/.test(url) && availableCredit === "pending")
      return new Promise(() => undefined);
    if (/^\/customers\/[^/]+\/statement$/.test(url))
      return Promise.resolve({
        data: {
          outstandingAmount: 0,
          overdueAmount: 0,
          availableCredit: availableCredit as number,
        },
      });
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0, timezone: "UTC" } });
    if (url === "/orders/counter-sale/parked")
      return Promise.resolve({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
    return Promise.resolve({ data: [] });
  });
  mutateAsync.mockResolvedValue(SALE);
});

const scanCase = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "CASE" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Case" });
};
const pickPlain = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "plain" } });
  fireEvent.click(screen.getByRole("option", { name: "Plain Cafe" }));
};
const complete = () =>
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
const sentPayment = () => mutateAsync.mock.calls[0][0].dto.payment;
const split = () => screen.queryByTestId("counter-part-pay-split");

describe("part payment by an identified customer (S4)", () => {
  it("CASH: a short tender is sent as the amount, not refused, and the rest stays open", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CASH", amount: 5 });
    expect(mutateAsync.mock.calls[0][0].dto.customerId).toBe("c-plain");
  });

  it("CHECK: the part amount is in the request body", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Check date")).toHaveValue(calendarDayInZone("UTC")),
    );
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({
      method: "CHECK",
      amount: 5,
      reference: "1042",
      checkDate: calendarDayInZone("UTC"),
    });
  });

  it("CARD: the part amount is in the request body", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD", amount: 5 });
  });

  it("a FULL card or check payment still omits the amount (blank, or the whole total)", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD" });
    expect(sentPayment()).not.toHaveProperty("amount");
  });

  it("an amount that covers the whole total is not a part payment either", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "12.5" } });
    expect(split()).toBeNull();
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD" });
  });
});

describe("open credit caps a check/card part (server parity)", () => {
  const payNow = (v: string) =>
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: v } });
  const card = () => fireEvent.click(screen.getByRole("radio", { name: "Card" }));

  it("$9 against a $12.50 sale with $4 credit is refused before submit (cap is $8.50)", async () => {
    availableCredit = 4;
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    card();
    await screen.findByText(/less any credit applied/i).catch(() => undefined);
    payNow("9");
    complete();
    expect(await screen.findByText(/\$8\.50/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("$8.50 goes through as a card part payment", async () => {
    availableCredit = 4;
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    card();
    await waitFor(() => expect(screen.getByLabelText("Amount paying now")).toBeInTheDocument());
    payNow("8.5");
    await screen.findByTestId("counter-part-pay-split");
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD", amount: 8.5 });
  });

  it("credit not read yet: a typed card part waits for the statement and submits nothing", async () => {
    availableCredit = "pending";
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    card();
    payNow("5");
    complete();
    expect(await screen.findByText(PART_PAY_CREDIT_PENDING_COPY)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("the split label", () => {
  it("a customer holding credit note balance: the label states no remainder of ours (the server applies credit)", async () => {
    availableCredit = 4;
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    await waitFor(() =>
      expect(screen.getByTestId("counter-part-pay-split")).toHaveTextContent(
        "Pay $5.00 now · the rest goes on account, less any credit applied",
      ),
    );
    expect(screen.getByTestId("counter-part-pay-split")).not.toHaveTextContent("$7.50");
  });

  it("reads 'Pay $X now · $Y goes on account' while a cash tender is short", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    expect(split()).toBeNull();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    expect(await screen.findByTestId("counter-part-pay-split")).toHaveTextContent(SPLIT);
    expect(split()?.textContent).toBe(SPLIT);
  });

  it("shows for a card or check part amount too, and goes away once the tender covers the total", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    expect((await screen.findByTestId("counter-part-pay-split")).textContent).toBe(SPLIT);
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "12.5" } });
    expect(split()).toBeNull();
  });

  it("never shows for On account (nothing is paid now)", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    expect(await screen.findByTestId("counter-part-pay-split")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    expect(split()).toBeNull();
  });
});

describe("a stale tender never becomes a silent part payment", () => {
  it.each(["Card", "Check"])(
    "cash typed short, then switching to %s: the field is blank, no amount is sent, no split label",
    async (name) => {
      renderTill(<CounterSaleScreen />);
      pickPlain();
      await scanCase();
      fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
      expect(await screen.findByTestId("counter-part-pay-split")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(screen.getByLabelText("Amount paying now")).toHaveValue("");
      expect(split()).toBeNull();
      if (name === "Check") {
        await waitFor(() =>
          expect(screen.getByLabelText("Check date")).toHaveValue(calendarDayInZone("UTC")),
        );
        fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
      }
      complete();
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(sentPayment()).not.toHaveProperty("amount");
      expect(sentPayment().method).toBe(name.toUpperCase());
    },
  );

  it("a card part amount, then switching to Check: cleared", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    expect(await screen.findByTestId("counter-part-pay-split")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    expect(screen.getByLabelText("Amount paying now")).toHaveValue("");
    expect(split()).toBeNull();
  });

  it("tapping the method that is already chosen keeps what was typed", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.getByLabelText("Amount paying now")).toHaveValue("5");
  });
});

describe("an amount that is not a positive number is refused, not read as a full payment", () => {
  const REFUSAL = "Enter an amount above zero, or leave it empty to pay in full.";
  it.each([
    ["Card", "0"],
    ["Card", "-5"],
    ["Card", "5,00"],
    ["Card", "abc"],
    ["Check", "0"],
    ["Check", "-5"],
    ["Check", "5,00"],
    ["Check", "abc"],
  ])("%s with %j: says so and sends nothing", async (name, typed) => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name }));
    if (name === "Check") {
      fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
    }
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: typed } });
    complete();
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
    // fixing the amount clears the refusal
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "5" } });
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it("blank (or only spaces) is still a full payment", async () => {
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    fireEvent.change(screen.getByLabelText("Amount paying now"), { target: { value: "  " } });
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD" });
  });
});

describe("the walk-in customer RECORD pays the full total", () => {
  const pickRecord = () => {
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "walk" } });
    fireEvent.click(screen.getByRole("option", { name: "Walk-in Record" }));
  };
  it("defaults to Cash, refuses a short cash tender, and has no part-pay field or split", async () => {
    renderTill(<CounterSaleScreen />);
    pickRecord();
    await scanCase();
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    expect(split()).toBeNull();
    complete();
    expect(await screen.findByText("Enter at least $12.50.")).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.queryByLabelText("Amount paying now")).toBeNull();
  });
});

describe("a walk-in still pays the full total", () => {
  it("a short cash tender is refused with the same sentence and no request", async () => {
    renderTill(<CounterSaleScreen />);
    await scanCase();
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    expect(split()).toBeNull();
    complete();
    expect(await screen.findByText("Enter at least $12.50.")).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("a card has no part-amount field, and sends no amount", async () => {
    renderTill(<CounterSaleScreen />);
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.queryByLabelText("Amount paying now")).toBeNull();
    complete();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayment()).toEqual({ method: "CARD" });
  });
});
