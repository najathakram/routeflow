import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within, act } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { addDays } from "@routeflow/pricing";
import { calendarDayInZone } from "@/lib/calendar-date";
import { COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY } from "@/lib/counter-sale";
import {
  cancelCounterLeave,
  getCounterLeaveRequest,
  guardCounterLeave,
} from "@/lib/counter-cart-signal";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { discardUndo } from "./useParkedSales";
import { setImpersonation } from "@/lib/impersonation";
import { liveCartKey } from "@/lib/counter-live-cart-keys";
import { parkStoredLiveCarts } from "@/lib/counter-live-cart-park";

/**
 * SA-748 PARK / RESUME at the counter. The API client is mocked at the module boundary by URL (a tiny in-memory "server" of
 * parked carts), the real park hooks and the real screen run. Park clears the screen ONLY after the server answered; Resume
 * asks "Park the current sale?" BEFORE any resume request when the cart has lines; every refusal shows FIXED copy.
 */

type MockUser = { id: string; tenantSlug: string; role?: string } | null | undefined;
let mockUser: MockUser;
const mockToast = jest.fn();
const mockDismiss = jest.fn();
let holdToasts = false; // true = the toast stays open (paused by hover, focus or a hidden window)
const dismissToast = (c: { onDismiss?: () => void }) => c.onDismiss?.();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: mockDismiss }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: mockUser }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 2.5,
  priceTier2: 2,
  unit: "each",
  unitsPerBox: null,
};
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const PRODUCTS: Record<string, unknown> = { COLA, WATER };
let slowScan: Promise<void> | null = null;
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    if (slowScan) await slowScan;
    return PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true };
  },
}));
const ACME = {
  id: "c-acme",
  businessName: "Acme Cafe",
  email: "buyer@acme.test",
  pricingTier: 2,
  fulfillPath: null,
};
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
const mutateAsync = jest.fn();
let salePending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: salePending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
const post = apiClient.post as unknown as jest.Mock;
const del = apiClient.delete as unknown as jest.Mock;
const PARKED = "/orders/counter-sale/parked";
const OPERATOR = { id: "u-o", tenantSlug: "acme", role: "OPERATOR" };
const ADMIN = { id: "u-a", tenantSlug: "acme", role: "TENANT_ADMIN" };
const SECRET = "SERVER SECRET MESSAGE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Row {
  id: string;
  label: string;
  registerKey: string;
  createdAt: string;
  expiresAt: string;
  lineCount: number;
  customerName?: string;
}
let rows: Row[];
let payloads: Record<string, unknown>;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
function seed(id: string, over: Partial<Row>, payload: unknown) {
  rows.push({
    id,
    label: "Walk-in · 14:41",
    registerKey: "main",
    createdAt: "2026-10-08T18:41:00.000Z",
    expiresAt: hoursAgo(-20),
    lineCount: 1,
    ...over,
  });
  payloads[id] = payload;
}
let withDraft = false; // only the W-1184 dock test has a paused order draft
const isResume = (url: unknown) => typeof url === "string" && /\/parked\/.+\/resume$/.test(url);
const resumeCalls = () => post.mock.calls.filter((c) => isResume(c[0]));
const parkCalls = () => post.mock.calls.filter((c) => c[0] === PARKED);

const parkedPayload = (over: Record<string, unknown> = {}) => ({
  lines: [
    {
      tempId: "r1",
      productId: "p-cola",
      name: "Cola",
      unitPrice: 2.5,
      qty: 2,
      listPrice: 2.5,
      unit: "each",
      priceType: "STANDARD",
      tierPrices: { pricePerUnit: 2.5, priceTier2: 2 },
    },
  ],
  customer: { id: "c-acme", businessName: "Acme Cafe", pricingTier: 2 },
  method: "CHECK",
  tendered: "",
  reference: "1042",
  ...over,
});

beforeEach(() => {
  mockToast.mockReset();
  mockDismiss.mockReset();
  holdToasts = false;
  mockToast.mockImplementation((c: { onDismiss?: () => void }) => {
    if (!holdToasts) setTimeout(() => dismissToast(c), 0);
    return "t";
  });
  discardUndo.ms = 0; // most tests want the delete at once; the Undo tests set their own window
  withDraft = false;
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockUser = OPERATOR;
  salePending = false;
  slowScan = null;
  rows = [];
  payloads = {};
  get.mockImplementation((url: string) => {
    if (url === "/settings")
      return Promise.resolve({ data: { taxRate: 0, timezone: "America/New_York" } });
    if (url === PARKED)
      return Promise.resolve({
        data: { data: [...rows], total: rows.length, page: 1, pageSize: 20 },
      });
    if (url === "/drafts")
      return Promise.resolve({
        data: !withDraft
          ? []
          : [
              {
                id: "d1",
                kind: "ORDER",
                title: null,
                customerName: "Acme Cafe",
                payload: { lineItems: [{ productId: "p1", unitPrice: 4, qty: 2 }] },
                updatedAt: new Date().toISOString(),
              },
            ],
      });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url: string, body?: { id: string; payload: unknown }) => {
    if (url === PARKED && body) {
      rows.push({
        id: body.id,
        label: "Walk-in · 14:50",
        registerKey: "main",
        createdAt: new Date().toISOString(),
        expiresAt: hoursAgo(-24),
        lineCount: (body.payload as { lines: unknown[] }).lines.length,
      });
      payloads[body.id] = body.payload;
      return Promise.resolve({ data: { id: body.id } });
    }
    const m = /\/parked\/(.+)\/resume$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!(id in payloads))
        return Promise.reject({
          response: { status: 404, data: { code: "PARK_TAKEN", message: SECRET } },
        });
      const payload = payloads[id];
      rows = rows.filter((r) => r.id !== id);
      delete payloads[id];
      return Promise.resolve({ data: { id, label: "x", createdAt: "t", payload } });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
  del.mockImplementation((url: string) => {
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    if (!(id in payloads))
      return Promise.reject({
        response: { status: 404, data: { code: "PARK_TAKEN", message: SECRET } },
      });
    rows = rows.filter((r) => r.id !== id);
    delete payloads[id];
    return Promise.resolve({ data: {} });
  });
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 5,
    paid: 5,
    balanceDue: 0,
    change: 0,
    paymentRecorded: true,
  });
});

const NAME: Record<string, string> = { COLA: "Cola", WATER: "Water" };
const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `Remove ${NAME[text]}` })).toBeInTheDocument(),
  );
};
const parkBtn = () => screen.getByRole("button", { name: "Park" });
const parkedBtn = () => screen.getByRole("button", { name: /^Parked/ });
const total = () => screen.getByTestId("running-total");
// by label, not role: a modal on top hides the cart from the accessibility tree
const itemNames = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Items"] > li')).map(
    (li) => li.textContent ?? "",
  );
async function pickAcme() {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("option", { name: "Acme Cafe" }));
  await waitFor(() => expect(screen.queryByTestId("counter-reprice-busy")).toBeNull());
}
async function openList(count?: number) {
  if (count !== undefined)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Parked (${count})` })).toBeInTheDocument(),
    );
  fireEvent.click(parkedBtn());
  return screen.findByRole("dialog", { name: "Parked sales" });
}
const resumeBtn = (label: string) => screen.getByRole("button", { name: `Resume ${label}` });
const discardBtn = (label: string) => screen.getByRole("button", { name: `Discard ${label}` });

function renderScreen() {
  return renderTill(<CounterSaleScreen />);
}

describe("header controls (nothing removed, Park and Parked added)", () => {
  it("keeps Today's sales and Ship this order instead next to Park and Parked", async () => {
    renderScreen();
    for (const name of ["Today's sales", "Ship this order instead", "Park"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }
    expect(parkedBtn()).toBeInTheDocument();
    for (const b of [parkBtn(), parkedBtn()]) expect(b.className).toContain("min-h-[44px]");
  });

  it("shows no count at zero and the count from the list total otherwise", async () => {
    seed("a", {}, parkedPayload());
    seed("b", {}, parkedPayload());
    renderScreen();
    expect(await screen.findByRole("button", { name: "Parked (2)" })).toBeInTheDocument();
  });

  it("at zero the button is just 'Parked'", async () => {
    renderScreen();
    await waitFor(() => expect(get).toHaveBeenCalledWith(PARKED, { params: { page: 1 } }));
    expect(parkedBtn()).toHaveTextContent(/^Parked$/);
  });
});

describe("Park", () => {
  it("is disabled on an empty cart and enabled once there is a line", async () => {
    renderScreen();
    expect(await screen.findByRole("button", { name: "Park" })).toBeDisabled();
    await scan("COLA");
    expect(parkBtn()).toBeEnabled();
  });

  it("is disabled while the sale POST is in flight", async () => {
    renderScreen();
    await scan("COLA");
    let finish: (v: unknown) => void = () => undefined;
    mutateAsync.mockReturnValue(new Promise((r) => (finish = r)));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(parkBtn()).toBeDisabled());
    finish({
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 2.5,
      paid: 2.5,
      balanceDue: 0,
      paymentRecorded: true,
    });
  });

  it("is disabled while a scan is still resolving", async () => {
    renderScreen();
    await scan("COLA");
    let release: () => void = () => undefined;
    slowScan = new Promise<void>((r) => (release = r));
    const field = screen.getByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "WATER" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(parkBtn()).toBeDisabled());
    release();
    await waitFor(() => expect(parkBtn()).toBeEnabled());
  });

  it("is disabled, and the parked list cannot be resumed, while the sale outcome is unknown", async () => {
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    await scan("COLA");
    mutateAsync.mockRejectedValue(new Error("network down"));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    expect(parkBtn()).toBeDisabled();
    await openList(1);
    expect(resumeBtn("Hold A")).toBeDisabled();
    fireEvent.click(resumeBtn("Hold A"));
    expect(resumeCalls()).toHaveLength(0);
  });

  it("is not on the receipt view (the receipt has no Park)", async () => {
    renderScreen();
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(screen.queryByRole("button", { name: "Park" })).toBeNull();
  });

  it("posts the whitelisted payload (no email), clears the screen only AFTER the answer, refocuses the scan field", async () => {
    renderScreen();
    await scan("COLA");
    await scan("COLA");
    await pickAcme();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1042" } });
    let answer: (v: unknown) => void = () => undefined;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    // still on screen: nothing clears before the server answered
    expect(itemNames().join(" ")).toContain("Cola");
    expect(screen.getByText("Acme Cafe", { selector: "span" })).toBeInTheDocument();

    const body = parkCalls()[0][1];
    expect(Object.keys(body).sort()).toEqual(["id", "payload"]);
    expect(body.id).toMatch(UUID);
    expect(JSON.stringify(body)).not.toContain("buyer@acme.test");
    expect(body.payload.customer).toEqual({
      id: "c-acme",
      businessName: "Acme Cafe",
      pricingTier: 2,
    });
    expect(body.payload.method).toBe("CHECK");
    expect(body.payload.reference).toBe("1042");
    expect(body.payload.lines).toHaveLength(1);
    expect(body.payload.lines[0]).toMatchObject({
      productId: "p-cola",
      name: "Cola",
      qty: 2,
      unitPrice: 2,
    });

    answer({ data: { id: body.id } });
    await waitFor(() => expect(itemNames().join(" ")).toContain("No items yet."));
    expect(screen.getByText("Who's buying?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
    expect(total()).toHaveTextContent("$0.00");
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });

  it("a failed park leaves the cart exactly as it was and shows a fixed line; the retry reuses the id", async () => {
    renderScreen();
    await scan("COLA");
    post.mockRejectedValueOnce({ response: { status: 500, data: { message: SECRET } } });
    fireEvent.click(parkBtn());
    const alert = await screen.findByText(/Couldn't park this sale/);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
    expect(itemNames().join(" ")).toContain("Cola");
    expect(parkBtn()).toBeEnabled();

    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(2));
    expect(parkCalls()[1][1].id).toBe(parkCalls()[0][1].id);
    await waitFor(() => expect(itemNames().join(" ")).toContain("No items yet."));
  });

  it("PARK_LIMIT shows the fixed copy, never the server message, and keeps the cart", async () => {
    renderScreen();
    await scan("COLA");
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "PARK_LIMIT", message: SECRET } },
    });
    fireEvent.click(parkBtn());
    expect(
      await screen.findByText(
        "This register already has 10 parked sales. Resume or discard one first.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
    expect(itemNames().join(" ")).toContain("Cola");
  });

  it("while a park is in flight, Complete and the line controls are off and no sale can be sent", async () => {
    renderScreen();
    await scan("COLA");
    let answer: (v: unknown) => void = () => undefined;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    const complete = screen.getByRole("button", { name: /Complete & show receipt/ });
    const completeNext = screen.getByRole("button", { name: /Complete & next sale/ });
    expect(complete).toBeDisabled();
    expect(completeNext).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeDisabled();
    fireEvent.click(complete);
    fireEvent.click(completeNext);
    expect(mutateAsync).not.toHaveBeenCalled();
    answer({ data: { id: "x" } });
    await waitFor(() => expect(itemNames().join(" ")).toContain("No items yet."));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("a cart that CHANGED while it was being parked is not cleared: it says so, and nothing is lost", async () => {
    renderScreen();
    await scan("COLA");
    let answer: (v: unknown) => void = () => undefined;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    // the payment side stays editable during the request: change it, then let the park answer
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "999" } });
    answer({ data: { id: "x" } });
    const note = await screen.findByTestId("counter-park-error");
    expect(note).toHaveTextContent(
      "The sale changed while it was being parked. It is saved in Parked sales as it was; check the cart before you continue.",
    );
    expect(itemNames().join(" ")).toContain("Cola");
    expect(screen.getByLabelText("Check number")).toHaveValue("999");
  });

  it("a double click is one park", async () => {
    renderScreen();
    await scan("COLA");
    let answer: (v: unknown) => void = () => undefined;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    fireEvent.click(parkBtn());
    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    answer({ data: { id: "x" } });
  });
});

describe("the Parked (n) list", () => {
  it("shows label, time, line count and customer; an old entry says its prices refresh", async () => {
    seed(
      "a",
      { label: "Hold A", lineCount: 3, customerName: "Acme Cafe", createdAt: hoursAgo(1) },
      parkedPayload(),
    );
    seed("b", { label: "Hold B", lineCount: 1, createdAt: hoursAgo(14) }, parkedPayload());
    renderScreen();
    const dialog = await openList(2);
    const a = within(dialog).getByTestId("parked-row-a");
    expect(a).toHaveTextContent("Hold A");
    expect(a).toHaveTextContent("3 lines");
    expect(a).toHaveTextContent("Acme Cafe");
    expect(a).toHaveTextContent(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(a).not.toHaveTextContent("prices refresh when you pay");
    const b = within(dialog).getByTestId("parked-row-b");
    expect(b).toHaveTextContent("1 line");
    expect(b).toHaveTextContent("from earlier — prices refresh when you pay");
    for (const btn of [resumeBtn("Hold A"), discardBtn("Hold A")])
      expect(btn.className).toMatch(/min-h-(\[44px\]|11)/);
  });

  it("formats the time in the business zone", async () => {
    seed("a", { label: "Hold A", createdAt: "2026-10-08T18:41:00.000Z" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    expect(within(dialog).getByTestId("parked-row-a")).toHaveTextContent("2:41 PM");
  });

  it("has an empty state", async () => {
    renderScreen();
    const dialog = await openList();
    expect(await within(dialog).findByText("No parked sales.")).toBeInTheDocument();
  });

  it("a failed list load says so and can retry", async () => {
    renderScreen();
    await waitFor(() => expect(get).toHaveBeenCalledWith(PARKED, { params: { page: 1 } }));
    get.mockImplementation((url: string) =>
      url === PARKED
        ? Promise.reject({ response: { status: 500, data: { message: SECRET } } })
        : Promise.resolve({ data: { taxRate: 0 } }),
    );
    const dialog = await openList();
    expect(await within(dialog).findByText("Couldn't load the parked sales.")).toBeInTheDocument();
    expect(within(dialog).queryByText(new RegExp(SECRET))).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("refetches when the list opens", async () => {
    renderScreen();
    await waitFor(() => expect(get).toHaveBeenCalledWith(PARKED, { params: { page: 1 } }));
    const before = get.mock.calls.filter((c) => c[0] === PARKED).length;
    await openList();
    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === PARKED).length).toBeGreaterThan(before),
    );
  });
});

describe("Resume with an empty cart", () => {
  it("restores the same lines, customer, method and reference, re-prices for display, mints no sale key", async () => {
    seed("a", { label: "Hold A", customerName: "Acme Cafe" }, parkedPayload({ tendered: "" }));
    renderScreen();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(resumeCalls()).toHaveLength(1));
    expect(resumeCalls()[0][0]).toBe(`${PARKED}/a/resume`);
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(itemNames().join(" ")).toContain("2");
    expect(screen.getByText("Acme Cafe", { selector: "span.font-medium" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Check" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Check number")).toHaveValue("1042");
    // parked at 2.50, Acme's tier-2 price is 2.00: the DISPLAY follows the customer
    await waitFor(() => expect(total()).toHaveTextContent("$4.00"));
    expect(screen.queryByRole("dialog", { name: "Parked sales" })).toBeNull();
    expect(mutateAsync).not.toHaveBeenCalled(); // no sale, no key
    expect(screen.queryByRole("dialog")).toBeNull(); // and no prompt for an empty cart
  });

  it("restores cash tendered", async () => {
    seed(
      "a",
      { label: "Hold A" },
      parkedPayload({ customer: null, method: "CASH", tendered: "20", reference: "" }),
    );
    renderScreen();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(screen.getByLabelText("Amount tendered")).toHaveValue("20"));
    // an older park (no walkIn flag) never said who was buying: the till asks, it does not assume a walk-in
    expect(screen.getByText("Who's buying?")).toBeInTheDocument();
  });

  it("PARK_TAKEN shows the fixed copy, leaves the cart as it was and refreshes the list", async () => {
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    await openList(1);
    delete payloads.a; // another till took it
    const gets = get.mock.calls.filter((c) => c[0] === PARKED).length;
    fireEvent.click(resumeBtn("Hold A"));
    expect(
      await screen.findByText("That parked sale was already taken back or has expired."),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
    expect(itemNames().join(" ")).toContain("No items yet.");
    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === PARKED).length).toBeGreaterThan(gets),
    );
  });
});

describe("Resume with lines on the cart: the replace prompt comes FIRST", () => {
  async function withCurrentCart() {
    seed(
      "a",
      { label: "Hold A" },
      parkedPayload({ customer: null, method: "CASH", reference: "" }),
    );
    renderScreen();
    await scan("WATER");
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    return screen.findByRole("dialog", { name: "Park the current sale?" });
  }

  it("asks before sending anything; Cancel sends nothing and keeps the cart", async () => {
    const prompt = await withCurrentCart();
    expect(resumeCalls()).toHaveLength(0);
    expect(parkCalls()).toHaveLength(0);
    for (const name of ["Park it", "Discard it", "Cancel"])
      expect(within(prompt).getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Park the current sale?" })).toBeNull(),
    );
    expect(resumeCalls()).toHaveLength(0);
    expect(parkCalls()).toHaveLength(0);
    expect(itemNames().join(" ")).toContain("Water");
  });

  it("Park it parks the current cart FIRST, then resumes the chosen one", async () => {
    const prompt = await withCurrentCart();
    fireEvent.click(within(prompt).getByRole("button", { name: "Park it" }));
    await waitFor(() => expect(resumeCalls()).toHaveLength(1));
    expect(parkCalls()).toHaveLength(1);
    expect(post.mock.calls.findIndex((c) => c[0] === PARKED)).toBeLessThan(
      post.mock.calls.findIndex((c) => isResume(c[0])),
    );
    expect(parkCalls()[0][1].payload.lines[0]).toMatchObject({
      name: expect.stringContaining("Water"),
    });
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(itemNames().join(" ")).not.toContain("Water");
    // the current cart is now a parked sale
    expect(rows.some((r) => r.lineCount === 1 && r.id !== "a")).toBe(true);
  });

  it("if Park it fails, nothing is resumed and the cart stays", async () => {
    const prompt = await withCurrentCart();
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "PARK_LIMIT", message: SECRET } },
    });
    fireEvent.click(within(prompt).getByRole("button", { name: "Park it" }));
    expect(
      await screen.findByText(
        "This register already has 10 parked sales. Resume or discard one first.",
      ),
    ).toBeInTheDocument();
    expect(resumeCalls()).toHaveLength(0);
    expect(itemNames().join(" ")).toContain("Water");
  });

  it("Discard it drops the current cart and resumes the chosen one", async () => {
    const prompt = await withCurrentCart();
    fireEvent.click(within(prompt).getByRole("button", { name: "Discard it" }));
    await waitFor(() => expect(resumeCalls()).toHaveLength(1));
    expect(parkCalls()).toHaveLength(0);
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(itemNames().join(" ")).not.toContain("Water");
  });

  it("Discard it with a resume that is refused (PARK_TAKEN) leaves the current cart as it was", async () => {
    const prompt = await withCurrentCart();
    delete payloads.a;
    fireEvent.click(within(prompt).getByRole("button", { name: "Discard it" }));
    expect(
      await screen.findByText("That parked sale was already taken back or has expired."),
    ).toBeInTheDocument();
    expect(itemNames().join(" ")).toContain("Water");
  });
});

describe("Discard a parked sale", () => {
  it("W-1184: Discard hides the row and offers Undo; Undo brings it back and no delete is sent", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    await waitFor(() => expect(within(dialog).queryByTestId("parked-row-a")).toBeNull());
    expect(del).not.toHaveBeenCalled();
    const undo = mockToast.mock.calls.map((c) => c[0]).find((c) => /^Discarded/.test(c.title));
    expect(undo?.action?.label).toBe("Undo");
    act(() => undo.action.onClick());
    expect(await within(dialog).findByTestId("parked-row-a")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("an order draft Discard gets the same Undo: row hides, no delete until the window ends, Undo brings it back", async () => {
    holdToasts = true;
    withDraft = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    const row = await within(dialog).findByTestId("draft-row-d1");
    fireEvent.click(within(row).getByRole("button", { name: /^Discard / }));
    await waitFor(() => expect(within(dialog).queryByTestId("draft-row-d1")).toBeNull());
    expect(del).not.toHaveBeenCalled();
    const undo = mockToast.mock.calls.map((c) => c[0]).find((c) => /^Discarded/.test(c.title));
    expect(undo?.action?.label).toBe("Undo");
    act(() => undo.action.onClick());
    expect(await within(dialog).findByTestId("draft-row-d1")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("the parked order draft row pins its line text: 1 line · amount · paused", async () => {
    withDraft = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    const row = await within(dialog).findByTestId("draft-row-d1");
    expect(row).toHaveTextContent("1 line · $8.00 · paused just now");
  });

  it("an order draft Discard that is not undone sends the delete once the window ends", async () => {
    withDraft = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    const row = await within(dialog).findByTestId("draft-row-d1");
    fireEvent.click(within(row).getByRole("button", { name: /^Discard / }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(del).toHaveBeenCalledWith("/drafts/d1"));
  });

  it("signing out right after a leave-park makes exactly one park request (the stored cart goes with the park)", async () => {
    renderScreen();
    await scan("COLA");
    const key = liveCartKey("acme", "u-o")!;
    await waitFor(() => expect(window.localStorage.getItem(key)).not.toBeNull());
    let storedAtProceed: string | null = "unset";
    const proceed = jest.fn(() => {
      storedAtProceed = window.localStorage.getItem(key);
    });
    expect(guardCounterLeave(proceed)).toBe(true);
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(storedAtProceed).toBeNull();
    await parkStoredLiveCarts(key); // what the sign-out runs next
    expect(parkCalls()).toHaveLength(1);
  });

  it("a late Undo still works: the delete waits for the toast to close, not for a separate timer", async () => {
    holdToasts = true; // hover / focus / hidden window keeps the toast open past the old 8 s
    discardUndo.ms = 20;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    await waitFor(() => expect(within(dialog).queryByTestId("parked-row-a")).toBeNull());
    await new Promise((r) => setTimeout(r, 150));
    expect(del).not.toHaveBeenCalled();
    const undo = mockToast.mock.calls.map((c) => c[0]).find((c) => /^Discarded/.test(c.title));
    act(() => undo.action.onClick());
    expect(await within(dialog).findByTestId("parked-row-a")).toBeInTheDocument();
    act(() => undo.onDismiss());
    expect(del).not.toHaveBeenCalled();
  });

  it("leaving the screen does not delete while the toast is open; closing it then deletes, Undo keeps the sale", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    seed("b", { label: "Hold B" }, parkedPayload());
    const { unmount } = renderScreen();
    await openList(2);
    fireEvent.click(discardBtn("Hold A"));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    fireEvent.click(discardBtn("Hold B"));
    await waitFor(() => expect(mockToast.mock.calls.length).toBeGreaterThanOrEqual(2));
    unmount();
    expect(del).not.toHaveBeenCalled(); // leaving never commits a delete whose Undo is still on screen
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    act(() => toasts[0].action.onClick()); // Undo A after leaving: A is kept
    act(() => toasts[0].onDismiss());
    act(() => toasts[1].onDismiss()); // B's toast just closed: B goes
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith(`${PARKED}/b`);
  });

  it("Undo is inside the open Parked window and takes focus, so a keyboard reaches it (the toast sits outside it)", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    const undo = await within(dialog).findByRole("button", { name: /^Undo/ });
    await waitFor(() => expect(undo).toHaveFocus());
    fireEvent.click(undo);
    expect(await within(dialog).findByTestId("parked-row-a")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("no auto-park during a support session: the leave is held on the old Discard question and nothing is parked", async () => {
    setImpersonation("tok", "acme", "support");
    renderScreen();
    await scan("COLA");
    const proceed = jest.fn();
    expect(guardCounterLeave(proceed)).toBe(true);
    // the shell header owns the question; here the leave is held on it and nothing was parked
    await waitFor(() => expect(getCounterLeaveRequest()).toBe(true));
    expect(proceed).not.toHaveBeenCalled();
    expect(parkCalls()).toHaveLength(0);
    cancelCounterLeave();
  });

  it("a stale toast never acts on a later discard: Discard A, Undo in the window, Discard A again, first toast closes", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Undo/ })); // the in-window Undo
    fireEvent.click(await within(dialog).findByRole("button", { name: "Discard Hold A" }));
    await waitFor(() => expect(within(dialog).queryByTestId("parked-row-a")).toBeNull());
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    expect(toasts).toHaveLength(2);
    act(() => toasts[0].onDismiss()); // the FIRST toast finally closes
    await new Promise((r) => setTimeout(r, 50));
    expect(del).not.toHaveBeenCalled(); // it must not delete the sale the second discard is still waiting on
    expect(within(dialog).getAllByRole("button", { name: /^Undo/ })).toHaveLength(1);
    act(() => toasts[1].action.onClick()); // the second toast's own Undo still works
    expect(await within(dialog).findByTestId("parked-row-a")).toBeInTheDocument();
    act(() => toasts[1].onDismiss());
    expect(del).not.toHaveBeenCalled();
  });

  it("the same for an order draft: a stale toast never acts on a later discard of the same draft", async () => {
    holdToasts = true;
    withDraft = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    const discardDraft = async () =>
      fireEvent.click(
        within(await within(dialog).findByTestId("draft-row-d1")).getByRole("button", {
          name: /^Discard /,
        }),
      );
    await discardDraft();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Undo/ }));
    await discardDraft();
    await waitFor(() => expect(within(dialog).queryByTestId("draft-row-d1")).toBeNull());
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    expect(toasts).toHaveLength(2);
    act(() => toasts[0].onDismiss());
    await new Promise((r) => setTimeout(r, 50)); // a delete would leave on the next ticks
    expect(del).not.toHaveBeenCalled();
    expect(within(dialog).getAllByRole("button", { name: /^Undo/ })).toHaveLength(1);
    act(() => toasts[1].action.onClick());
    expect(await within(dialog).findByTestId("draft-row-d1")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("the in-window Undo also closes its own toast", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Undo/ }));
    expect(mockDismiss).toHaveBeenCalledWith("t");
  });

  it("an early toast close (Escape) while the Parked window shows the Undo sends no delete until the window closes", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    await within(dialog).findByRole("button", { name: /^Undo/ });
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    act(() => toasts[0].onDismiss()); // Escape closed the toast first
    await new Promise((r) => setTimeout(r, 50));
    expect(del).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: /^Undo/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Undo/ }));
    expect(await within(dialog).findByTestId("parked-row-a")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("the delete of a toast closed early goes out when the Parked window closes", async () => {
    holdToasts = true;
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    fireEvent.click(discardBtn("Hold A"));
    await within(dialog).findByRole("button", { name: /^Undo/ });
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    act(() => toasts[0].onDismiss());
    expect(del).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" }); // the window closes
    await waitFor(() => expect(del).toHaveBeenCalledWith(`${PARKED}/a`));
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("an early toast close for an order draft is held the same way while its Undo is in the window", async () => {
    holdToasts = true;
    withDraft = true;
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Parked (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    fireEvent.click(
      within(await within(dialog).findByTestId("draft-row-d1")).getByRole("button", {
        name: /^Discard /,
      }),
    );
    await within(dialog).findByRole("button", { name: /^Undo/ });
    const toasts = mockToast.mock.calls.map((c) => c[0]).filter((c) => /^Discarded/.test(c.title));
    act(() => toasts[0].onDismiss());
    await new Promise((r) => setTimeout(r, 50));
    expect(del).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: /^Undo/ })).toBeInTheDocument();
  });

  it("calls DELETE, refreshes the list, and the row goes", async () => {
    seed("a", { label: "Hold A" }, parkedPayload());
    seed("b", { label: "Hold B" }, parkedPayload());
    renderScreen();
    const dialog = await openList(2);
    fireEvent.click(discardBtn("Hold A"));
    fireEvent.keyDown(dialog, { key: "Escape" }); // the toast closed while the window showed its Undo: the delete leaves with the window
    await waitFor(() => expect(del).toHaveBeenCalledWith(`${PARKED}/a`));
    const again = await openList();
    await waitFor(() => expect(within(again).queryByTestId("parked-row-a")).toBeNull());
    expect(within(again).getByTestId("parked-row-b")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Parked (1)", hidden: true }),
    ).toBeInTheDocument();
  });

  it("PARK_TAKEN shows the fixed copy and the list refetches", async () => {
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    const dialog = await openList(1);
    delete payloads.a;
    rows = [];
    fireEvent.click(discardBtn("Hold A"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(del).toHaveBeenCalled());
    const again = await openList();
    expect(
      await within(again).findByText("That parked sale was already taken back or has expired."),
    ).toBeInTheDocument();
    expect(within(again).queryByText(new RegExp(SECRET))).toBeNull();
    await waitFor(() => expect(within(again).queryByTestId("parked-row-a")).toBeNull());
  });
});

describe("SA-1071 C3: the walk-in Undo belongs to the sale it was made on", () => {
  it("resuming a parked walk-in sale ends it, so it can't put the old customer on that sale", async () => {
    seed("a", { label: "Hold A" }, parkedPayload({ customer: null, walkIn: true }));
    renderScreen();
    await pickAcme();
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    expect(await screen.findByText("Now a walk-in sale.")).toBeInTheDocument();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(screen.queryByText("Now a walk-in sale.")).toBeNull();
  });
});

describe("price edits on a resumed cart (the existing Complete-time check)", () => {
  const edited = () =>
    parkedPayload({
      customer: null,
      walkIn: true, // S5: this cart was parked after Walk-in was tapped
      method: "CASH",
      reference: "",
      lines: [
        {
          tempId: "r1",
          productId: "p-cola",
          name: "Cola",
          unitPrice: 1.5,
          qty: 2,
          listPrice: 2.5,
          tierPrices: { pricePerUnit: 2.5, priceTier2: 2 },
          priceEdited: true,
          tierPrice: 2.5,
          override: { mode: "set", value: 1.5, reason: "damaged box" },
        },
      ],
    });

  it("a clerk who cannot edit prices is told, and Complete sends the edited price so the server's refusal shows its fixed copy", async () => {
    // SA-762r Ruling A: an OPERATOR may edit prices (staffMay EDIT_LINE_PRICE); SUPER_ADMIN is still outside the gate.
    mockUser = { ...OPERATOR, role: "SUPER_ADMIN" };
    seed("a", { label: "Hold A" }, edited());
    renderScreen();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(
      await screen.findByText(/edited prices and you can't change prices/),
    ).toBeInTheDocument();
    mutateAsync.mockRejectedValueOnce({
      response: { status: 403, data: { code: "PRICE_EDIT_NOT_PERMITTED", message: SECRET } },
    });
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByText(COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY)).toBeInTheDocument();
    expect(mutateAsync.mock.calls[0][0].dto.items[0]).toMatchObject({
      productId: "p-cola",
      unitPrice: 1.5,
      priceReason: "damaged box",
    });
  });

  it("an admin sees no warning and keeps the edit", async () => {
    mockUser = ADMIN;
    seed("a", { label: "Hold A" }, edited());
    renderScreen();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(screen.queryByText(/edited prices and you can't change prices/)).toBeNull();
    expect(screen.getByTestId("line-price-chip")).toBeInTheDocument();
  });
});

describe("W-1184: leaving parks the sale", () => {
  it("every leave parks the open sale, then goes: no Discard question, one park, the sale stored", async () => {
    renderScreen();
    await scan("COLA");
    const proceed = jest.fn();
    expect(guardCounterLeave(proceed)).toBe(true);
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(parkCalls()).toHaveLength(1);
    expect(screen.queryByText("Discard this sale?")).toBeNull();
  });

  it("one Parked button holds the order drafts too: count, section, Resume (no separate Drafts button)", async () => {
    withDraft = true;
    renderScreen();
    expect(await screen.findByRole("button", { name: "Parked (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Drafts/ })).toBeNull();
    fireEvent.click(parkedBtn());
    const dialog = await screen.findByRole("dialog", { name: "Parked sales" });
    const row = await within(dialog).findByTestId("draft-row-d1");
    expect(row).toHaveTextContent("Order, Acme Cafe");
    expect(within(row).getByRole("button", { name: /^Resume / })).toBeInTheDocument();
  });

  it("an empty till with a parked sale offers one tap back into it", async () => {
    seed("a", { lineCount: 1 }, parkedPayload());
    renderScreen();
    expect(await screen.findByTestId("counter-resume-bar")).toHaveTextContent("Resume sale (");
  });

  it("Esc on the empty scan field moves the cursor to Resume sale (one key; Enter then decides)", async () => {
    seed("a", { lineCount: 1 }, parkedPayload());
    renderScreen();
    const bar = await screen.findByTestId("counter-resume-bar");
    const scanField = screen.getByLabelText("Scan or search items");
    scanField.focus();
    fireEvent.keyDown(scanField, { key: "Escape" });
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: /^Resume sale/ }));
  });
});

// W-1188 PR-2 (R24): the order date chip rides the park payload, the sale body, and resets with the sale.
describe("order date chip on the till", () => {
  const TODAY = calendarDayInZone("America/New_York");
  const YESTERDAY = addDays(TODAY, -1);
  const chip = () => screen.getByTestId("counter-date-chip");
  async function pickYesterday() {
    fireEvent.click(await screen.findByRole("button", { name: "Order date: today. Change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
  }

  it("reads Today and sends no orderDate at all", async () => {
    renderScreen();
    await scan("COLA");
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto).not.toHaveProperty("orderDate");
  });

  it("a chosen day is sent on the sale and a reminder sits above Complete", async () => {
    renderScreen();
    await scan("COLA");
    await pickYesterday();
    expect(screen.getByTestId("counter-date-reminder")).toHaveTextContent(
      "This sale will be dated",
    );
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.orderDate).toBe(YESTERDAY);
  });

  it("parks with the chosen day, and a resumed cart keeps it", async () => {
    renderScreen();
    await scan("COLA");
    await pickYesterday();
    fireEvent.click(parkBtn());
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    expect(parkCalls()[0][1].payload.orderDate).toBe(YESTERDAY);
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "TODAY")); // the next sale starts on Today
    await openList(1);
    fireEvent.click(screen.getByRole("button", { name: /^Resume / }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    expect(screen.getByRole("button", { name: /^Backdated to/ })).toBeInTheDocument();
  });

  it("a parked sale without a date resumes on Today", async () => {
    seed("a", { label: "Hold A" }, parkedPayload());
    renderScreen();
    await openList(1);
    fireEvent.click(resumeBtn("Hold A"));
    await waitFor(() => expect(itemNames().join(" ")).toContain("Cola"));
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });

  it("a finished sale does not carry its date to the next one", async () => {
    renderScreen();
    await scan("COLA");
    await pickYesterday();
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // the mocked server total differs from the screen's, so the receipt shows first; its New sale starts the next one
    fireEvent.click(await screen.findByRole("button", { name: /New sale/ }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "TODAY"));
  });

  it("a reload keeps the chosen day: the chip comes back dated and Complete still sends it", async () => {
    const view = renderScreen();
    await scan("COLA");
    await pickYesterday();
    const liveKey = () =>
      Object.keys(window.localStorage).find((k) => k.includes("liveCart")) as string;
    await waitFor(() => {
      const saved = window.localStorage.getItem(liveKey());
      expect(saved && JSON.parse(saved).orderDate).toBe(YESTERDAY);
    });
    view.unmount();
    renderScreen();
    await screen.findByTestId("counter-cart-restored");
    await waitFor(() => expect(chip()).toHaveAttribute("data-direction", "BACK"));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.orderDate).toBe(YESTERDAY);
  });

  it("a refused date shows fixed copy and a red ring, and the date stays for the clerk to fix", async () => {
    renderScreen();
    await scan("COLA");
    await pickYesterday();
    mutateAsync.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          code: "ORDER_DATE_OUT_OF_RANGE",
          message: SECRET,
          min: "2024-11-09",
          max: "2027-11-10",
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByText(/more than 2 years back/)).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(chip().className).toContain("ring-red-500");
    expect(chip()).toHaveAttribute("data-direction", "BACK");
  });
});
