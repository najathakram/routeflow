import * as React from "react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { renderWithProviders } from "@/test-utils/render";
import { sanitizeParkedPayload } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import { writeHeldAttempt } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-933 / W-822(a): picking a customer sets the counter's DEFAULT tender from their effective payment terms (Net N is On
 * account, Due on Receipt / a walk-in is Cash), but only while nobody has decided the tender in this sale: not the clerk,
 * and never a held (outcome unknown) sale, a replayed attempt, a parked sale being resumed or a cart restored after a refresh.
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
const CUSTOMERS = [
  { id: "c-net", businessName: "Net Cafe", pricingTier: 1 },
  { id: "c-cod", businessName: "Receipt Cafe", pricingTier: 1 },
  { id: "c-plain", businessName: "Plain Cafe", pricingTier: 1 },
];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: CUSTOMERS } }),
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

const get = apiClient.get as unknown as jest.Mock;
const post = apiClient.post as unknown as jest.Mock;
const PARKED = "/orders/counter-sale/parked";
const OWN_TERMS: Record<string, string> = {
  "c-net": "Net 30",
  "c-cod": "Due on Receipt",
  "c-plain": "",
};
let tenantDefault: string;
let customerRead: ((id: string) => Promise<{ data: unknown }>) | null;
let parkedRows: { id: string; label: string; payload: unknown }[];

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  tenantDefault = "Net 30";
  customerRead = null;
  parkedRows = [];
  get.mockImplementation((url: string) => {
    const m = /^\/customers\/([^/]+)$/.exec(url);
    if (m)
      return customerRead
        ? customerRead(m[1])
        : Promise.resolve({ data: { id: m[1], defaultPaymentTerms: OWN_TERMS[m[1]] ?? "" } });
    if (url === "/settings/invoice")
      return Promise.resolve({ data: { defaultTerms: tenantDefault } });
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0, timezone: "UTC" } });
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
  post.mockImplementation((url: string) => {
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
});

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = (name: string) => radio(name).getAttribute("aria-checked") === "true";
const pick = (name: string) => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "cafe" } });
  fireEvent.click(screen.getByRole("option", { name }));
};
/** The customer panel shows the terms once both reads landed: the default has had its chance by then. */
const settled = (terms: string) =>
  waitFor(() => expect(screen.getByTestId("counter-customer-terms")).toHaveTextContent(terms));

const colaLine = {
  tempId: "p-cola-0",
  productId: "p-cola",
  name: "Cola",
  unitPrice: 2.5,
  qty: 3,
  listPrice: 2.5,
  unit: "each",
  priceType: "STANDARD",
};
const NET_CUSTOMER = { id: "c-net", businessName: "Net Cafe", pricingTier: 1 };

describe("the default tender follows the picked customer's terms", () => {
  it("a Net-terms customer picked before any choice sets On account", async () => {
    renderTill(<CounterSaleScreen />);
    expect(checked("Cash")).toBe(true);
    pick("Net Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
    expect(checked("Cash")).toBe(false);
  });

  it("a Due on Receipt customer stays on Cash", async () => {
    renderTill(<CounterSaleScreen />);
    pick("Receipt Cafe");
    await settled("Due on Receipt");
    expect(checked("Cash")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("a customer with no terms of their own follows the business default, either way", async () => {
    const { unmount } = renderTill(<CounterSaleScreen />);
    pick("Plain Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
    unmount();
    window.localStorage.clear();
    tenantDefault = "Due on Receipt";
    renderTill(<CounterSaleScreen />);
    pick("Plain Cafe");
    await settled("Due on Receipt");
    expect(checked("Cash")).toBe(true);
  });

  it("switching customers before any choice re-derives it each time", async () => {
    renderTill(<CounterSaleScreen />);
    pick("Net Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
    pick("Receipt Cafe");
    await waitFor(() => expect(checked("Cash")).toBe(true));
  });

  it("clearing back to Walk-in returns to Cash when the clerk never chose", async () => {
    renderTill(<CounterSaleScreen />);
    pick("Net Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    await waitFor(() => expect(checked("Cash")).toBe(true));
  });
});

describe("a tender the clerk chose is never overwritten", () => {
  it("after the clerk tapped Cash, a later pick of a Net customer does not change it", async () => {
    renderTill(<CounterSaleScreen />);
    fireEvent.click(radio("Cash"));
    pick("Net Cafe");
    await settled("Net 30");
    expect(checked("Cash")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("a tender chosen BEFORE the customer's terms arrive is kept when they do", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    customerRead = async (id) => {
      await held;
      return { data: { id, defaultPaymentTerms: OWN_TERMS[id] } };
    };
    renderTill(<CounterSaleScreen />);
    pick("Net Cafe");
    fireEvent.click(radio("Card"));
    release();
    await settled("Net 30");
    expect(checked("Card")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("the chosen tender survives clearing to Walk-in and picking another customer", async () => {
    renderTill(<CounterSaleScreen />);
    pick("Receipt Cafe");
    await settled("Due on Receipt");
    fireEvent.click(radio("Card"));
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    expect(checked("Card")).toBe(true);
    pick("Net Cafe");
    await settled("Net 30");
    expect(checked("Card")).toBe(true);
  });
});

describe("a restored sale keeps the tender it was saved with", () => {
  it("a held (outcome unknown) sale, and its replay once unlocked, are never overwritten", async () => {
    writeHeldAttempt("rf.counterSale.heldAttempt:acme:u-a", {
      key: "k-held",
      dto: {
        customerId: "c-net",
        items: [{ productId: "p-cola", qty: 1 }],
        payment: { method: "CHECK", reference: "1042" },
      },
      next: false,
      estimate: { total: 2.5, change: 0 },
      lines: [colaLine],
      customer: NET_CUSTOMER,
      method: "CHECK",
      tendered: "",
      reference: "1042",
    });
    lookupSale.mockRejectedValueOnce({
      response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
    });
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByTestId("counter-outcome-unknown");
    await settled("Net 30");
    expect(checked("Check")).toBe(true);
    expect(checked("On account")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));
    await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
    expect(checked("Check")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("a parked sale being resumed keeps its tender", async () => {
    parkedRows.push({
      id: "park-1",
      label: "Hold A",
      payload: {
        lines: [colaLine],
        customer: NET_CUSTOMER,
        method: "CHECK",
        tendered: "",
        reference: "1042",
      },
    });
    renderTill(<CounterSaleScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume Hold A" }));
    await screen.findByRole("button", { name: "Remove Cola" });
    await settled("Net 30");
    expect(checked("Check")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("a parked CARD sale keeps its part amount and its split label", async () => {
    parkedRows.push({
      id: "park-2",
      label: "Hold B",
      payload: {
        lines: [colaLine],
        customer: NET_CUSTOMER,
        method: "CARD",
        tendered: "5",
        reference: "",
      },
    });
    renderTill(<CounterSaleScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume Hold B" }));
    await screen.findByRole("button", { name: "Remove Cola" });
    await settled("Net 30");
    expect(checked("Card")).toBe(true);
    expect(screen.getByLabelText("Amount paying now")).toHaveValue("5");
    expect(screen.getByTestId("counter-part-pay-split").textContent).toBe(
      "Pay $5.00 now \u00b7 $2.50 goes on account",
    );
  });

  it("a cart restored after a refresh keeps its tender", async () => {
    window.sessionStorage.setItem("rf.counterSale.tabId", "tab-from-before-the-refresh");
    window.localStorage.setItem(
      "rf.counterSale.liveCart:acme:u-a",
      JSON.stringify({
        v: 1,
        owner: "tab-from-before-the-refresh",
        lines: [colaLine],
        customer: NET_CUSTOMER,
        method: "CARD",
        tendered: "",
        reference: "",
      }),
    );
    renderTill(<CounterSaleScreen />);
    await screen.findByTestId("counter-cart-restored");
    await settled("Net 30");
    expect(checked("Card")).toBe(true);
    expect(checked("On account")).toBe(false);
  });

  it("the next sale after a reset starts undecided again", async () => {
    renderTill(<CounterSaleScreen />);
    pick("Net Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
    fireEvent.click(radio("Card"));
    mutateAsync.mockResolvedValue({
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 2.5,
      paid: 2.5,
      balanceDue: 0,
      paymentRecorded: true,
    });
    const field = screen.getByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "COLA" } });
    fireEvent.submit(field.closest("form")!);
    await screen.findByRole("button", { name: "Remove Cola" });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    pick("Net Cafe");
    await waitFor(() => expect(checked("On account")).toBe(true));
  });
});
