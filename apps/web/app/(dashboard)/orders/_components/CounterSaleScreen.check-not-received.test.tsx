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
 * SA-1026 A-R1 on the till: inside the Check tender a named customer gets one choice, "Check not received yet". It hides the
 * number and date, and the sale goes out as ON_ACCOUNT + expectedMethod CHECK with no reference and no checkDate. A walk-in
 * is never offered it. The check number field stays for every other Check sale.
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

const CHOICE = "Check not received yet";
const named = async () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
};
const complete = () =>
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));

describe("CounterSaleScreen: Check not received yet (SA-1026 A-R1)", () => {
  it("a named customer under Check is offered it; Cash and Card do not show it", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    expect(screen.queryByLabelText(CHOICE)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    expect(screen.getByLabelText(CHOICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.queryByLabelText(CHOICE)).toBeNull();
  });

  it("a walk-in is never offered it; the check number stays", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    expect(screen.queryByLabelText(CHOICE)).toBeNull();
    expect(screen.getByLabelText("Check number")).toBeInTheDocument();
  });

  it("choosing it hides the number and date, and sends ON_ACCOUNT + CHECK with no reference and no checkDate", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
    fireEvent.click(screen.getByLabelText(CHOICE));
    expect(screen.queryByLabelText("Check number")).toBeNull();
    expect(screen.queryByLabelText("Check date")).toBeNull();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({
      method: "ON_ACCOUNT",
      expectedMethod: "CHECK",
    });
  });

  it("a future check date does not block it (no check is tendered)", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
    fireEvent.change(screen.getByLabelText("Check date"), { target: { value: dayPlus(3) } });
    fireEvent.click(screen.getByLabelText(CHOICE));
    expect(screen.queryByTestId("counter-check-postdated")).toBeNull();
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({
      method: "ON_ACCOUNT",
      expectedMethod: "CHECK",
    });
  });

  it("without it a Check still needs its number (the pin is kept)", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    complete();
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((a) => a.textContent === "Enter the check number."),
      ).toBe(true),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("choosing another tender after it drops the intent", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    fireEvent.click(screen.getByLabelText(CHOICE));
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    complete();
    await screen.findByTestId("counter-sale-receipt");
    expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({ method: "CARD" });
  });

  it("a new sale starts without the choice", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    fireEvent.click(screen.getByLabelText(CHOICE));
    complete();
    await screen.findByTestId("counter-sale-receipt");
    fireEvent.click(screen.getByRole("button", { name: /new sale/i }));
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    expect((screen.getByLabelText(CHOICE) as HTMLInputElement).checked).toBe(false);
  });
});

/**
 * SA-1026 A-R2: ticking "Check not received yet" clears the check number typed before it, so no snapshot (park, refresh)
 * can resume the sale as a Check with a number and no tick, which would send a CHECK payment for a check nobody has.
 */
describe("CounterSaleScreen: the tick clears a typed check number (SA-1026 A-R2)", () => {
  const typedThenTicked = async () => {
    await scan("COLA");
    await named();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    await waitFor(() => expect(screen.getByLabelText("Check date")).toHaveValue(dayPlus(0)));
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
    fireEvent.click(screen.getByLabelText(CHOICE));
  };
  const refusedWithNumberCopy = async () => {
    complete();
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((a) => a.textContent === "Enter the check number."),
      ).toBe(true),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  };

  it("a parked then resumed sale has an empty number field and Complete is refused", async () => {
    renderTill(<CounterSaleScreen />);
    await typedThenTicked();
    fireEvent.click(screen.getByRole("button", { name: "Park" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Park" })).toBeDisabled());
    fireEvent.click(await screen.findByRole("button", { name: /^Parked/ }));
    await screen.findByRole("dialog", { name: "Parked sales" });
    fireEvent.click(await screen.findByRole("button", { name: /^Resume / }));
    await screen.findByRole("button", { name: "Remove Cola" });
    expect(screen.getByLabelText("Check number")).toHaveValue("");
    await refusedWithNumberCopy();
  });

  it("a refreshed sale (the stored live cart) comes back with an empty number field and Complete is refused", async () => {
    const first = renderTill(<CounterSaleScreen />);
    await typedThenTicked();
    window.dispatchEvent(new Event("pagehide")); // the refresh: the stored cart is flushed
    first.unmount();
    renderTill(<CounterSaleScreen />);
    await screen.findByRole("button", { name: "Remove Cola" });
    expect(screen.getByLabelText("Check number")).toHaveValue("");
    await refusedWithNumberCopy();
  });
});
