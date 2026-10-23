import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { sanitizeParkedPayload } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import {
  COUNTER_CHECK_ZONE_FAILED_COPY,
  COUNTER_CHECK_ZONE_LOADING_COPY,
  writeHeldAttempt,
} from "@/lib/counter-sale";
import { calendarDayInZone } from "@/lib/calendar-date";
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
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
const mutateAsync = jest.fn();
const lookupSale = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: lookupSale, isPending: false }),
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
  const d = new Date(`${calendarDayInZone("UTC")}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const get = apiClient.get as unknown as jest.Mock;
const post = apiClient.post as unknown as jest.Mock;
const PARKED = "/orders/counter-sale/parked";
let parkedRows: { id: string; label: string; payload: unknown }[];
const settingsOk = (timezone: string | null = "UTC") =>
  get.mockImplementation((url: string) => {
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0, timezone } });
    if (url === PARKED)
      return Promise.resolve({
        data: {
          data: parkedRows.map((r) => ({
            id: r.id,
            label: r.label,
            registerKey: "main",
            createdAt: "2026-10-08T18:41:00.000Z",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            lineCount: 1,
          })),
          total: parkedRows.length,
          page: 1,
          pageSize: 20,
        },
      });
    return Promise.resolve({ data: [] });
  });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  parkedRows = [];
  settingsOk();
  // the park "server": stores the body it was sent, and rebuilds it with the REAL shared sanitizer on resume
  post.mockImplementation((url: string, body?: { id: string; payload: unknown }) => {
    if (url === PARKED && body) {
      parkedRows.push({ id: body.id, label: "Hold A", payload: body.payload });
      return Promise.resolve({ data: { id: body.id } });
    }
    const m = /\/parked\/(.+)\/resume$/.exec(url);
    if (m) {
      const row = parkedRows.find((r) => r.id === decodeURIComponent(m[1]));
      parkedRows = parkedRows.filter((r) => r !== row);
      const clean = sanitizeParkedPayload(row?.payload, ["CASH", "CARD", "CHECK", "ON_ACCOUNT"]);
      return Promise.resolve({
        data: { id: row?.id, label: "x", createdAt: "t", payload: clean.ok ? clean.value : null },
      });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
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
    renderTill(<CounterSaleScreen />);
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
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(-3) } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe(dayPlus(-3));
  });

  it("a future date shows the sentence; Complete is refused with it and nothing is sent", async () => {
    renderTill(<CounterSaleScreen />);
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
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
    expect(screen.getByRole("button", { name: "Put this sale on account" })).toBeDisabled();
  });

  it("a named customer: Put this sale on account switches the tender, hides the check fields, and sells on account with no checkDate", async () => {
    renderTill(<CounterSaleScreen />);
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
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(-1) } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & next sale" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await scan("COLA");
    await chooseCheck(); // asserts the date is back to today
  });

  describe("the business's day is unknown (review round 1: never judged against UTC)", () => {
    it("zone still loading: Complete is refused with the loading copy, nothing is sent, and the fields say so", async () => {
      get.mockImplementation(() => new Promise(() => undefined));
      renderTill(<CounterSaleScreen />);
      await scan("COLA");
      fireEvent.click(screen.getByRole("radio", { name: "Check" }));
      fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
      expect(screen.getByTestId("counter-check-zone-loading")).toHaveTextContent(
        COUNTER_CHECK_ZONE_LOADING_COPY,
      );
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("alert")
            .some((a) => a.textContent === COUNTER_CHECK_ZONE_LOADING_COPY),
        ).toBe(true),
      );
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("zone read failed: refused with the failed copy and a Retry; a successful retry lets the sale through", async () => {
      get.mockRejectedValue(new Error("settings down"));
      renderTill(<CounterSaleScreen />);
      await scan("COLA");
      fireEvent.click(screen.getByRole("radio", { name: "Check" }));
      fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
      const retry = await screen.findByRole("button", { name: "Retry" });
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("alert")
            .some((a) => a.textContent === COUNTER_CHECK_ZONE_FAILED_COPY),
        ).toBe(true),
      );
      expect(mutateAsync).not.toHaveBeenCalled();
      settingsOk();
      fireEvent.click(retry);
      await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await screen.findByTestId("counter-sale-receipt");
      expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe(dayPlus(0));
    });

    it("Sydney 08:00 on the 22nd (UTC still the 21st): a check dated the 22nd is the tenant's today and is tendered", async () => {
      jest.useFakeTimers({
        now: new Date("2026-10-21T21:00:00Z"),
        doNotFake: [
          "hrtime",
          "nextTick",
          "performance",
          "queueMicrotask",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "setImmediate",
          "clearImmediate",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
        ] as never,
      });
      try {
        settingsOk("Australia/Sydney");
        renderTill(<CounterSaleScreen />);
        await scan("COLA");
        fireEvent.click(screen.getByRole("radio", { name: "Check" }));
        await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue("2026-10-22"));
        fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
        expect(screen.queryByTestId("counter-check-postdated")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await screen.findByTestId("counter-sale-receipt");
        expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe("2026-10-22");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("the day is read when Complete is pressed (#3615 review)", () => {
    const fakeNow = (iso: string) =>
      jest.useFakeTimers({
        now: new Date(iso),
        doNotFake: [
          "hrtime",
          "nextTick",
          "performance",
          "queueMicrotask",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "setImmediate",
          "clearImmediate",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
        ] as never,
      });
    it("a till left idle across the business's midnight sends the NEW day, not the day it was drawn on", async () => {
      fakeNow("2026-10-22T23:59:30Z");
      try {
        renderTill(<CounterSaleScreen />);
        await scan("COLA");
        fireEvent.click(screen.getByRole("radio", { name: "Check" }));
        await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue("2026-10-22"));
        fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
        jest.setSystemTime(new Date("2026-10-23T00:00:30Z")); // midnight passes with nothing re-drawn
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await screen.findByTestId("counter-sale-receipt");
        expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe("2026-10-23");
      } finally {
        jest.useRealTimers();
      }
    });
    it("a check typed for tomorrow just before midnight is tendered once midnight has passed", async () => {
      fakeNow("2026-10-22T23:59:30Z");
      try {
        renderTill(<CounterSaleScreen />);
        await scan("COLA");
        fireEvent.click(screen.getByRole("radio", { name: "Check" }));
        await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue("2026-10-22"));
        fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
        fireEvent.change(screen.getByLabelText("Check date"), { target: { value: "2026-10-23" } });
        expect(screen.getByTestId("counter-check-postdated")).toHaveTextContent(SENTENCE);
        jest.setSystemTime(new Date("2026-10-23T00:00:30Z"));
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await screen.findByTestId("counter-sale-receipt");
        expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe("2026-10-23");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("a restored held sale (#3615 review)", () => {
    const HELD = "rf.counterSale.heldAttempt:acme:u-a";
    const hold = (checkDate: string | undefined, sent: string) =>
      writeHeldAttempt(HELD, {
        key: "k-held",
        dto: {
          walkIn: true,
          items: [{ productId: COLA.id, qty: 1 }],
          payment: { method: "CHECK", reference: "1042", checkDate: sent },
        },
        next: false,
        estimate: { total: 2.5, change: 0 },
        lines: [{ tempId: "t1", productId: COLA.id, name: "Cola", unitPrice: 2.5, qty: 1 }],
        customer: null,
        method: "CHECK",
        tendered: "",
        reference: "1042",
        ...(checkDate === undefined ? {} : { checkDate }),
      });
    it("shows the date the attempt SENT, not today, when the clerk had left the date at its default", async () => {
      hold("", dayPlus(-1));
      renderTill(<CounterSaleScreen />);
      await screen.findByTestId("counter-outcome-unknown");
      await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(-1)));
    });
    it("a stored check date that is not a real day is dropped: once unlocked, the sale is dated today", async () => {
      hold("2026-02-31", dayPlus(0));
      lookupSale.mockRejectedValueOnce({
        response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
      });
      renderTill(<CounterSaleScreen />);
      await screen.findByTestId("counter-outcome-unknown");
      fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));
      await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
      await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await screen.findByTestId("counter-sale-receipt");
      expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe(dayPlus(0));
    });
  });

  describe("a typed check date survives park / resume, a refresh and a held sale (review round 1)", () => {
    it("park with a future date -> resume (through the real sanitizer) -> the date is back and Complete is refused", async () => {
      renderTill(<CounterSaleScreen />);
      await scan("COLA");
      await chooseCheck();
      fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
      fireEvent.click(screen.getByRole("button", { name: "Park" }));
      await waitFor(() => expect(parkedRows).toHaveLength(1));
      expect((parkedRows[0].payload as { checkDate?: string }).checkDate).toBe(dayPlus(1));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Cola" })).toBeNull());
      fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
      fireEvent.click(await screen.findByRole("button", { name: "Resume Hold A" }));
      await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(1)));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() =>
        expect(screen.getAllByRole("alert").some((a) => a.textContent === SENTENCE)).toBe(true),
      );
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("a refresh keeps the typed date (real write, real read) and Complete is still refused", async () => {
      const view = renderTill(<CounterSaleScreen />);
      await scan("COLA");
      await chooseCheck();
      fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
      const KEY = "rf.counterSale.liveCart:acme:u-a";
      await waitFor(() => {
        const saved = window.localStorage.getItem(KEY);
        expect(saved && JSON.parse(saved).checkDate).toBe(dayPlus(1));
      });
      view.unmount();
      renderTill(<CounterSaleScreen />);
      await screen.findByTestId("counter-cart-restored");
      await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(1)));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() =>
        expect(screen.getAllByRole("alert").some((a) => a.textContent === SENTENCE)).toBe(true),
      );
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("a held (outcome unknown) sale: the retry sends the typed checkDate, and a restored held sale SHOWS it, not today", async () => {
      mutateAsync.mockRejectedValueOnce(new Error("Network Error"));
      const view = renderTill(<CounterSaleScreen />);
      await scan("COLA");
      await chooseCheck();
      fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(-2) } });
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await screen.findByTestId("counter-outcome-unknown");
      expect(mutateAsync.mock.calls[0][0].dto.payment.checkDate).toBe(dayPlus(-2));
      view.unmount();
      renderTill(<CounterSaleScreen />);
      await screen.findByTestId("counter-outcome-unknown");
      expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(-2)); // RED on the old code: it showed today
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(mutateAsync.mock.calls[1][0].dto.payment.checkDate).toBe(dayPlus(-2)); // guard, green on the old code
    });
  });

  it("Put this sale on account clears the post-dated alert and lands focus on the On account tender", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
    await chooseCheck();
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(1) } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some(
            (a) =>
              a.textContent === SENTENCE && !a.closest('[data-testid="counter-check-postdated"]'),
          ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Put this sale on account" }));
    expect(
      screen.queryAllByRole("alert", { hidden: true }).some((a) => a.textContent === SENTENCE),
    ).toBe(false);
    expect(screen.getByRole("radio", { name: "On account" })).toHaveFocus();
  });
});
