import * as React from "react";
import { renderWithProviders, screen, fireEvent, waitFor, within, act } from "@/test-utils/render";
import { useCreateCounterSale } from "@/lib/api/counter-sale";
import type { TodaysSaleRow, TodaysSalesResponse, TodaysSalesSummary } from "@routeflow/types";
import {
  cancelCounterLeave,
  confirmCounterLeave,
  getCounterLeaveRequest,
  setCounterCartHasLines,
} from "@/lib/counter-cart-signal";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * POS-7b-2: the counter's "Today's sales" sheet. The API (POS-7b-1) is mocked at the apiClient boundary; the order read, the
 * add-on and the role are mocked exactly like CounterReturnAction's own tests, so the Return gating is the REAL one.
 */
const get = jest.fn();
const post = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
let addon = true;
let role: string | undefined = "OPERATOR";
let username = "pat";
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => addon }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username } : null }),
}));
const ORDER = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  total: 22.5,
  customer: { businessName: "Walk-in" },
  lineItems: [
    { id: "l1", name: "Cola", qty: 3, unitPrice: 2.5 },
    { id: "l2", name: "Chips", qty: 3, unitPrice: 5 },
  ],
};
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: ORDER }) }));
let closeDialog: (() => void) | undefined;
let recordReturn: ((r: unknown, info?: unknown) => void) | undefined;
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: {
    open: boolean;
    onClose: () => void;
    onRecorded?: (r: unknown, info?: unknown) => void;
  }) => {
    closeDialog = p.onClose;
    recordReturn = p.onRecorded;
    return p.open ? <div data-testid="return-dialog" /> : null;
  },
}));

const row = (over: Partial<TodaysSaleRow> = {}): TodaysSaleRow => ({
  orderId: "o1",
  invoiceId: "i1",
  orderNumber: "ORD-1",
  invoiceNumber: "INV-1",
  createdAt: "2026-10-07T15:15:00.000Z",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  customerId: "c1",
  customerName: "Walk-in",
  isWalkIn: true,
  status: "DELIVERED",
  paymentState: "PAID",
  methods: [{ method: "CASH", amount: 22.5 }],
  cashTendered: null,
  change: null,
  taxRatePercent: null,
  returned: { amount: 0, state: "NONE", returns: [] },
  voided: false,
  ...over,
});
const SUMMARY: TodaysSalesSummary = {
  sales: { count: 2, total: 45 },
  moneyIn: { cash: 30, card: 15, check: 0, other: 1, total: 46 },
  handOvers: { count: 0, total: 0 },
  storeCreditUsed: 4,
  onAccount: 7,
  refunds: { count: 1, cash: 0, card: 0, check: 0, other: 0, total: 5, tenderKnown: false },
  storeCreditIssued: { count: 1, amount: 2 },
  cashExpectedInDrawer: 25,
  netCollected: 41,
};
const resp = (
  rows: TodaysSaleRow[],
  over: { page?: number; totalPages?: number; summary?: TodaysSalesSummary | null } = {},
): TodaysSalesResponse => ({
  data: rows,
  meta: {
    total: rows.length,
    page: over.page ?? 1,
    limit: 25,
    totalPages: over.totalPages ?? 1,
    day: "2026-10-07",
    timezone: "America/New_York",
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-08T04:00:00.000Z",
  },
  summary: over.summary === undefined ? SUMMARY : over.summary,
});
const page1 = (rows: TodaysSaleRow[] = [row()], over = {}) => resp(rows, over);
const serve = (pages: Record<number, TodaysSalesResponse>) =>
  get.mockImplementation((url: string, cfg?: { params?: { page?: number } }) => {
    if (url === "/orders/counter-sale/today")
      return Promise.resolve({ data: pages[cfg?.params?.page ?? 1] });
    return Promise.resolve({ data: {} });
  });
const todayCalls = () => get.mock.calls.filter((c) => c[0] === "/orders/counter-sale/today");
const open = async () => {
  const r = renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  return r;
};

afterEach(() => {
  cancelCounterLeave();
  setCounterCartHasLines(false);
});

beforeEach(() => {
  jest.clearAllMocks();
  addon = true;
  role = "OPERATOR";
  serve({ 1: page1() });
});

describe("CounterTodaysSales", () => {
  it("opens the sheet from the header button and fetches only then", async () => {
    renderWithProviders(<CounterTodaysSales />);
    expect(todayCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(todayCalls()).toHaveLength(1));
    expect(todayCalls()[0][1]).toEqual({ params: { page: 1 } });
  });

  it("shows a loading state while page 1 is in flight", async () => {
    get.mockImplementation(() => new Promise(() => {}));
    await open();
    expect(await screen.findByText("Loading today's sales")).toBeInTheDocument();
  });

  it("shows the empty copy when there are no sales", async () => {
    serve({ 1: page1([], { summary: { ...SUMMARY, sales: { count: 0, total: 0 } } }) });
    await open();
    expect(await screen.findByText("No sales yet today")).toBeInTheDocument();
  });

  it("shows fixed error copy with Retry, never the server text, and Retry refetches", async () => {
    get.mockRejectedValue({ response: { data: { message: "PG boom: relation missing" } } });
    await open();
    expect(await screen.findByText("Could not load today's sales.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PG boom/);
    const before = todayCalls().length;
    serve({ 1: page1() });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ORD-1")).toBeInTheDocument();
    expect(todayCalls().length).toBeGreaterThan(before);
  });

  it("Show more fetches the next page and appends its rows; gone on the last page", async () => {
    serve({
      1: page1([row()], { totalPages: 2 }),
      2: resp([row({ orderId: "o2", orderNumber: "ORD-2" })], {
        page: 2,
        totalPages: 2,
        summary: null,
      }),
    });
    await open();
    await screen.findByText("ORD-1");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("ORD-2")).toBeInTheDocument();
    expect(screen.getByText("ORD-1")).toBeInTheDocument();
    expect(todayCalls()[1][1]).toEqual({ params: { page: 2 } });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("renders the summary: sales, money in by method, cash expected", async () => {
    await open();
    const s = await screen.findByTestId("today-summary");
    expect(within(s).getByText("2 sales")).toBeInTheDocument();
    expect(within(s).getByText("$45.00")).toBeInTheDocument();
    expect(within(s).getByTestId("today-in-cash")).toHaveTextContent("$30.00");
    expect(within(s).getByTestId("today-in-card")).toHaveTextContent("$15.00");
    expect(within(s).getByTestId("today-in-check")).toHaveTextContent("$0.00");
    expect(within(s).getByTestId("today-in-other")).toHaveTextContent("$1.00");
    expect(within(s).getByTestId("today-in-total")).toHaveTextContent("$46.00");
    expect(within(s).getByTestId("today-store-credit-used")).toHaveTextContent("$4.00");
    expect(within(s).getByTestId("today-on-account")).toHaveTextContent("$7.00");
    expect(within(s).getByTestId("today-store-credit-issued")).toHaveTextContent("$2.00");
    expect(within(s).getByTestId("today-net-collected")).toHaveTextContent("$41.00");
  });

  it("refunds are ONE total with no per-method split while the tender is unknown", async () => {
    await open();
    const s = await screen.findByTestId("today-summary");
    expect(within(s).getByTestId("today-refunds")).toHaveTextContent("$5.00");
    expect(within(s).queryByTestId("today-refunds-cash")).toBeNull();
    expect(within(s).queryByTestId("today-refunds-card")).toBeNull();
    expect(within(s).getByTestId("today-cash-expected")).toHaveTextContent(
      "Cash expected, before refunds",
    );
    expect(within(s).getByTestId("today-cash-expected")).toHaveTextContent("$25.00");
  });
  it("shows the server's refund total as-is: no client sum of the parts", async () => {
    serve({
      1: page1([row()], {
        summary: { ...SUMMARY, refunds: { ...SUMMARY.refunds, other: 1, total: 99 } },
      }),
    });
    await open();
    expect(await screen.findByTestId("today-refunds")).toHaveTextContent("$99.00");
  });

  it("splits refunds by method once the tender is known", async () => {
    serve({
      1: page1([row()], {
        summary: {
          ...SUMMARY,
          refunds: { count: 2, cash: 3, card: 2, check: 0, other: 0, total: 5, tenderKnown: true },
        },
      }),
    });
    await open();
    expect(await screen.findByTestId("today-refunds-cash")).toHaveTextContent("$3.00");
    expect(screen.getByTestId("today-refunds-card")).toHaveTextContent("$2.00");
    expect(screen.getByTestId("today-cash-expected")).not.toHaveTextContent("before refunds");
  });

  it("SA-740r2: some refunds with a recorded method and some without: the breakdown shows, and the labels say what is missing", async () => {
    serve({
      1: page1([row()], {
        summary: {
          ...SUMMARY,
          refunds: { count: 2, cash: 3, card: 0, check: 0, other: 2, total: 5, tenderKnown: false },
          cashExpectedInDrawer: 27,
        },
      }),
    });
    await open();
    expect(await screen.findByTestId("today-refunds-cash")).toHaveTextContent("$3.00");
    expect(screen.getByTestId("today-refunds-other")).toHaveTextContent("$2.00");
    expect(screen.getByTestId("today-refunds")).toHaveTextContent(
      /some without a recorded method/i,
    );
    expect(screen.getByTestId("today-cash-expected")).toHaveTextContent(
      /before refunds with no method recorded/i,
    );
  });

  it("a voided row is labelled Voided, struck through, with no Reprint or Return", async () => {
    serve({ 1: page1([row({ voided: true })]) });
    await open();
    const r = await screen.findByTestId("today-row-o1");
    expect(within(r).getByText("Voided")).toBeInTheDocument();
    expect(within(r).getByText("ORD-1").className).toMatch(/line-through/);
    expect(within(r).queryByRole("button", { name: "Return items" })).toBeNull();
    expect(within(r).queryByRole("button", { name: "Reprint" })).toBeNull();
    expect(within(r).getByRole("link", { name: "View order" })).toBeInTheDocument();
  });

  it("Reprint opens the shared receipt view: 'Reprint · Sold Wed, Oct 7, 11:15 AM', no Tendered or Change", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-reprint")).toHaveTextContent(
      /^Reprint · Sold Wed, Oct 7, 11:15 AM$/,
    );
    expect(within(root).getByTestId("receipt-numbers")).toHaveTextContent("Order ORD-1");
    expect(within(root).getByTestId("receipt-total")).toHaveTextContent("$22.50");
    expect(within(root).getByTestId("receipt-method")).toHaveTextContent("Cash");
    expect(root.textContent).not.toMatch(/Tendered|Change/);
    fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
    expect(await screen.findByTestId("today-row-o1")).toBeInTheDocument();
  });

  it("SA-764: a reprint with tendered 50 shows Tendered and the server's Change, not browser math", async () => {
    // change 7.5 is deliberately NOT tendered - cash (27.5): the figure must be the row's, as given
    serve({ 1: page1([row({ cashTendered: 50, change: 7.5 })]) });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-tendered")).toHaveTextContent("$50.00");
    expect(within(root).getByTestId("receipt-change")).toHaveTextContent("$7.50");
  });

  it("SA-764: a legacy row (cashTendered and change null) shows neither line and no $0.00 change", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).queryByTestId("receipt-tendered")).toBeNull();
    expect(within(root).queryByTestId("receipt-change")).toBeNull();
    expect(root.textContent).not.toMatch(/Change|\$0\.00/);
  });

  it.each([["exactly", 1.86]])(
    "SA-764: the reprint labels the tax 'Tax (8.25%%)' when the stored tax is %s",
    async (_n, tax) => {
      const saved = { ...ORDER };
      Object.assign(ORDER, { tax, total: 22.5 + tax });
      try {
        serve({ 1: page1([row({ taxRatePercent: 8.25, total: 22.5 + tax })]) });
        await open();
        fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
        const root = await screen.findByTestId("receipt-print-root");
        expect(root.textContent).toContain("Tax (8.25%)");
      } finally {
        delete (ORDER as { tax?: number }).tax;
        Object.assign(ORDER, saved);
      }
    },
  );

  it("SA-762r: a reprint prints a named customer and the settings footer; a walk-in row prints no customer line", async () => {
    get.mockImplementation((url: string) =>
      url === "/orders/counter-sale/today"
        ? Promise.resolve({
            data: page1([
              row({ customerName: "Acme Co", isWalkIn: false }),
              row({ orderId: "o2", orderNumber: "ORD-2", invoiceId: "i2", invoiceNumber: "INV-2" }),
            ]),
          })
        : url === "/settings"
          ? Promise.resolve({ data: { receiptFooter: "Thanks!\nSee you soon" } })
          : Promise.resolve({ data: {} }),
    );
    await open();
    const named = await screen.findByTestId("today-row-o1");
    fireEvent.click(within(named).getByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-customer")).toHaveTextContent("Customer: Acme Co");
    expect((await within(root).findByTestId("receipt-footer")).textContent).toBe(
      "Thanks!\nSee you soon",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
    fireEvent.click(
      within(await screen.findByTestId("today-row-o2")).getByRole("button", { name: "Reprint" }),
    );
    const root2 = await screen.findByTestId("receipt-print-root");
    expect(within(root2).queryByTestId("receipt-customer")).toBeNull();
  });

  // CQ-21: print media keeps the dialog backdrop and has no page margins.
  it("a printed sheet drops the dialog backdrop and carries page margins (list) or the 80 mm page (reprint)", async () => {
    await open();
    await screen.findByTestId("today-row-o1");
    const overlay = document.querySelector("[data-modal-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass("print:hidden");
    const pageRules = () =>
      Array.from(screen.getByRole("dialog").querySelectorAll("style")).map((s) => s.textContent);
    expect(pageRules().join("")).toMatch(/@page\s*\{\s*margin:\s*10mm/);
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    await screen.findByTestId("receipt-print-root");
    // the reprint sets its own page (80 mm, 4 mm margins) and the list's rule is gone, so the two never fight
    expect(pageRules().join("")).not.toMatch(/margin:\s*10mm/);
    expect(pageRules().join("")).toMatch(/margin:\s*4mm/);
    expect(document.querySelector("[data-modal-overlay]")).toHaveClass("print:hidden");
  });

  it("while a reprint is open the page prints only the receipt; closing it undoes that", async () => {
    await open();
    expect(document.body.classList.contains("counter-reprint-open")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(document.body.classList.contains("counter-reprint-open")).toBe(true);
    const dialog = screen.getByRole("dialog");
    // the modal's own title row is print-hidden; the receipt body is not
    expect(dialog.className).toContain("print:[&>div:first-child]:hidden");
    expect(root.closest(".print\\:hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
    await screen.findByTestId("today-row-o1");
    expect(document.body.classList.contains("counter-reprint-open")).toBe(false);
    expect(screen.getByRole("dialog").className).not.toContain("print:[&>div:first-child]:hidden");
  });

  it("a row names its items; an old server's row shows none", async () => {
    serve({
      1: page1([
        row({
          orderId: "o1",
          items: [
            { name: "Cola 12oz Can", qty: 2 },
            { name: "Ice Bag 10lb", qty: 1 },
            { name: "Chips", qty: 1 },
          ],
          itemCount: 3,
        }),
        row({ orderId: "o2", orderNumber: "ORD-2" }),
      ]),
    });
    await open();
    const r1 = await screen.findByTestId("today-row-o1");
    expect(within(r1).getByTestId("today-row-items")).toHaveTextContent(
      "Cola 12oz Can ×2, Ice Bag 10lb +1 more",
    );
    expect(
      within(await screen.findByTestId("today-row-o2")).queryByTestId("today-row-items"),
    ).toBeNull();
  });

  it("row 317: a row names its cashier; an old row (no stored cashier) names none", async () => {
    serve({
      1: page1([
        row({ orderId: "o1", cashierName: "jane" }),
        row({ orderId: "o2", orderNumber: "ORD-2", cashierName: null }),
        row({ orderId: "o3", orderNumber: "ORD-3" }),
      ]),
    });
    await open();
    const r1 = await screen.findByTestId("today-row-o1");
    expect(within(r1).getByTestId("today-row-cashier")).toHaveTextContent("Cashier: jane");
    expect(
      within(await screen.findByTestId("today-row-o2")).queryByTestId("today-row-cashier"),
    ).toBeNull();
    expect(
      within(await screen.findByTestId("today-row-o3")).queryByTestId("today-row-cashier"),
    ).toBeNull();
  });

  it("row 317: 'Reprinted by' follows the shared name rule: an email-shaped username is not printed", async () => {
    const original = username;
    username = "pat@acme.test";
    try {
      await open();
      fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
      const root = await screen.findByTestId("receipt-print-root");
      expect(within(root).queryByTestId("receipt-reprinted-by")).toBeNull();
      expect(root.textContent).not.toContain("pat@acme.test");
    } finally {
      username = original;
    }
  });

  it("row 317: the reprint of a sale with a stored cashier prints 'Cashier: <name>' beside who reprinted it", async () => {
    serve({ 1: page1([row({ cashierName: "jane" })]) });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-cashier")).toHaveTextContent("Cashier: jane");
    expect(within(root).getByTestId("receipt-reprinted-by")).toHaveTextContent("Reprinted by pat");
    // owner ruling (A): both are staff-facing on screen only; the printed reprint (the customer's copy) carries neither
    expect(within(root).getByTestId("receipt-cashier")).toHaveClass("print:hidden");
    expect(within(root).getByTestId("receipt-reprinted-by")).toHaveClass("print:hidden");
    expect(within(root).getByTestId("receipt-numbers")).not.toHaveClass("print:hidden");
  });

  it("a reprint of a sale with no stored cashier credits the reprinter, never a Cashier line", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-reprinted-by")).toHaveTextContent("Reprinted by pat");
    expect(within(root).queryByTestId("receipt-cashier")).toBeNull();
    expect(root.textContent).not.toMatch(/Cashier/);
  });

  it("a non-voided row without an invoice has no Reprint, but keeps View order", async () => {
    serve({ 1: page1([row({ invoiceId: null, invoiceNumber: null })]) });
    await open();
    const r = await screen.findByTestId("today-row-o1");
    expect(within(r).queryByRole("button", { name: "Reprint" })).toBeNull();
    expect(within(r).getByRole("link", { name: "View order" })).toBeInTheDocument();
  });

  it("Back to sales returns focus to that row's Reprint button", async () => {
    serve({ 1: page1([row({ orderId: "o1" }), row({ orderId: "o2", orderNumber: "ORD-2" })]) });
    await open();
    const r2 = await screen.findByTestId("today-row-o2");
    fireEvent.click(within(r2).getByRole("button", { name: "Reprint" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to sales" }));
    const again = within(await screen.findByTestId("today-row-o2")).getByRole("button", {
      name: "Reprint",
    });
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  it("reprint shows the server's paid and balance due, never a client sum", async () => {
    serve({
      1: page1([
        row({
          total: 20,
          paid: 15,
          balanceDue: 3,
          paymentState: "PARTLY_PAID",
          methods: [{ method: "CASH", amount: 9 }],
        }),
      ]),
    });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(root).toHaveTextContent("Paid$15.00");
    expect(root).toHaveTextContent("Balance due$3.00");
  });

  it("Return items is the real gate: hidden without the add-on", async () => {
    addon = false;
    await open();
    await screen.findByTestId("today-row-o1");
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
  });
  it.each(["CUSTOMER", "DRIVER"])("Return items is hidden for role %s", async (r) => {
    role = r;
    await open();
    await screen.findByTestId("today-row-o1");
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
  });
  it("Return items shows for staff with the add-on and opens the return dialog", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Return items" }));
    expect(screen.getByTestId("return-dialog")).toBeInTheDocument();
  });

  it("shows the payment-state and returned-state badges", async () => {
    serve({
      1: page1([
        row({
          paymentState: "PARTLY_PAID",
          returned: { amount: 2, state: "PARTLY", returns: [] },
        }),
        row({
          orderId: "o2",
          orderNumber: "ORD-2",
          paymentState: "ON_ACCOUNT",
          methods: [],
          returned: { amount: 0, state: "PENDING", returns: [] },
        }),
        row({
          orderId: "o3",
          orderNumber: "ORD-3",
          returned: { amount: 22.5, state: "FULL", returns: [] },
        }),
      ]),
    });
    await open();
    const r1 = await screen.findByTestId("today-row-o1");
    expect(within(r1).getByText("Partly paid")).toBeInTheDocument();
    expect(within(r1).getByText("Partly returned")).toBeInTheDocument();
    const r2 = screen.getByTestId("today-row-o2");
    expect(within(r2).getByText("On account")).toBeInTheDocument();
    expect(within(r2).getByText("Return pending")).toBeInTheDocument();
    expect(within(screen.getByTestId("today-row-o3")).getByText("Returned")).toBeInTheDocument();
  });

  it("store credit on a row is labelled store credit, not a tender", async () => {
    serve({
      1: page1([
        row({
          methods: [
            { method: "CASH", amount: 10 },
            { method: "STORE_CREDIT", amount: 12.5 },
          ],
        }),
      ]),
    });
    await open();
    const r = await screen.findByTestId("today-row-o1");
    expect(r).toHaveTextContent("Cash + Store credit");
  });

  it("formats times in the server's timezone", async () => {
    await open();
    // 15:15Z in America/New_York (EDT) is 11:15 AM
    expect(await screen.findByTestId("today-row-o1")).toHaveTextContent("11:15 AM");
  });

  it("View order links to the order detail route", async () => {
    await open();
    expect(await screen.findByRole("link", { name: "View order" })).toHaveAttribute(
      "href",
      "/orders/o1",
    );
  });

  it("refetches after a counter sale completes", async () => {
    function Harness() {
      const sale = useCreateCounterSale();
      return (
        <>
          <CounterTodaysSales />
          <button onClick={() => sale.mutate({ dto: {} as never, idempotencyKey: "k" })}>
            ring
          </button>
        </>
      );
    }
    post.mockResolvedValue({ data: { orderId: "o9" } });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
    await screen.findByTestId("today-row-o1");
    const before = todayCalls().length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ring", hidden: true }));
    });
    await waitFor(() => expect(todayCalls().length).toBeGreaterThan(before));
  });

  it("refetches after the return dialog closes", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Return items" }));
    const before = todayCalls().length;
    act(() => closeDialog?.());
    await waitFor(() => expect(todayCalls().length).toBeGreaterThan(before));
  });

  it("every row action is a 44 px tap target", async () => {
    await open();
    await screen.findByTestId("today-row-o1");
    for (const el of [
      screen.getByRole("button", { name: "Reprint" }),
      screen.getByRole("button", { name: "Return items" }),
      screen.getByRole("link", { name: "View order" }),
    ])
      expect(el.className).toMatch(/min-h-11/);
  });

  it("W21b: a fully returned sale offers no Return items; a partly returned one still does", async () => {
    serve({
      1: page1([
        row({ orderId: "o1", returned: { amount: 22.5, state: "FULL", returns: [] } }),
        row({
          orderId: "o2",
          orderNumber: "ORD-2",
          returned: { amount: 5, state: "PARTLY", returns: [] },
        }),
      ]),
    });
    await open();
    const full = await screen.findByTestId("today-row-o1");
    const partly = screen.getByTestId("today-row-o2");
    expect(within(full).queryByRole("button", { name: "Return items" })).toBeNull();
    expect(within(partly).getByRole("button", { name: "Return items" })).toBeInTheDocument();
  });

  it("W21b: a whole-sale return keeps its hand-back line after the refetch marks the row FULL", async () => {
    serve({
      1: page1([row({ orderId: "o1", returned: { amount: 0, state: "NONE", returns: [] } })]),
    });
    await open();
    const r = await screen.findByTestId("today-row-o1");
    fireEvent.click(within(r).getByRole("button", { name: "Return items" }));
    act(() => recordReturn?.({}, { resolution: "REFUND", tender: "CASH", amount: 22.5 }));
    serve({
      1: page1([row({ orderId: "o1", returned: { amount: 22.5, state: "FULL", returns: [] } })]),
    });
    act(() => closeDialog?.());
    await waitFor(() => expect(todayCalls().length).toBeGreaterThan(1));
    const after = await screen.findByTestId("today-row-o1");
    expect(within(after).getByRole("status")).toHaveTextContent(
      "Hand $22.50 back to the customer.",
    );
  });

  it("W21b: one Escape on the reprint view goes back to the list; a second closes the sheet", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    await screen.findByTestId("receipt-print-root");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(await screen.findByTestId("today-row-o1")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("W21b: Escape back from the reprint refocuses that row's Reprint button", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    await screen.findByTestId("receipt-print-root");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const again = within(await screen.findByTestId("today-row-o1")).getByRole("button", {
      name: "Reprint",
    });
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  it("W21b: the sheet's Close X is a 44 px target", async () => {
    await open();
    await screen.findByTestId("today-row-o1");
    const x = within(screen.getByRole("dialog")).getByRole("button", { name: "Close" });
    expect(x.className).toMatch(/min-h-11/);
    expect(x.className).toMatch(/min-w-11/);
  });

  it("W21b: closing the sheet with Escape returns focus to the Today's sales button", async () => {
    await open();
    await screen.findByTestId("today-row-o1");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Today's sales" })),
    );
  });
  it("View order with lines in the cart asks to discard first; Discard then opens the order", async () => {
    setCounterCartHasLines(true);
    await open();
    const link = await screen.findByRole("link", { name: "View order" });
    // fireEvent returns false when the click's default (the navigation) was prevented
    expect(fireEvent.click(link)).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(getCounterLeaveRequest()).toBe(true);
    act(() => confirmCounterLeave());
    expect(push).toHaveBeenCalledWith("/orders/o1");
  });

  it("View order with an empty cart is a plain link: not intercepted, nothing parked", async () => {
    await open();
    const link = await screen.findByRole("link", { name: "View order" });
    expect(fireEvent.click(link)).toBe(true);
    expect(getCounterLeaveRequest()).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Last 7 days (Train 4 b)", () => {
  const dayCalls = () =>
    todayCalls().filter((c) => (c[1] as { params?: { day?: string } })?.params?.day);
  const daySummary = (over: Partial<TodaysSalesSummary> = {}): TodaysSalesSummary => ({
    ...SUMMARY,
    refunds: { count: 1, cash: 2, card: 1, check: 0, other: 0, total: 3, tenderKnown: true },
    ...over,
  });
  const serveWeek = (fail?: string) =>
    get.mockImplementation((url: string, cfg?: { params?: { page?: number; day?: string } }) => {
      if (url !== "/orders/counter-sale/today") return Promise.resolve({ data: {} });
      const day = cfg?.params?.day;
      if (!day) return Promise.resolve({ data: page1() });
      if (day === fail)
        return Promise.reject({ response: { status: 500, data: { message: "RAW" } } });
      return Promise.resolve({
        data: { ...resp([], { summary: daySummary() }), meta: { ...resp([]).meta, day } },
      });
    });
  const toggle = () => screen.getByRole("button", { name: "Last 7 days" });

  it("fetches nothing for the week until the toggle is pressed, then one call per day, newest first, summary only", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    expect(dayCalls()).toHaveLength(0);
    fireEvent.click(toggle());
    await waitFor(() => expect(dayCalls()).toHaveLength(7));
    expect(dayCalls().map((c) => (c[1] as { params: { day: string } }).params.day)).toEqual([
      "2026-10-07",
      "2026-10-06",
      "2026-10-05",
      "2026-10-04",
      "2026-10-03",
      "2026-10-02",
      "2026-10-01",
    ]);
    for (const c of dayCalls()) {
      expect((c[1] as { params: { page: number; limit: number } }).params).toMatchObject({
        page: 1,
        limit: 1,
      });
    }
  });

  it("shows a week total and one block per day with sales, tender mix, refunds by tender, store credit, on account and cash expected", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    const total = await screen.findByTestId("week-total");
    expect(within(total).getByText("14 sales")).toBeInTheDocument(); // 7 days x 2
    expect(within(total).getByTestId("week-total-in-cash")).toHaveTextContent("$210.00");
    expect(within(total).getByTestId("week-total-refunds-card")).toHaveTextContent("$7.00");
    expect(within(total).getByTestId("week-total-store-credit-used")).toHaveTextContent("$28.00");
    expect(within(total).getByTestId("week-total-on-account")).toHaveTextContent("$49.00");
    expect(within(total).getByTestId("week-total-cash-expected")).toHaveTextContent("$175.00");
    expect(screen.getAllByTestId(/^week-day-\d{4}-\d{2}-\d{2}$/)).toHaveLength(7);
    const first = screen.getByTestId("week-day-2026-10-07");
    expect(within(first).getByText("2 sales")).toBeInTheDocument();
    expect(within(first).getByTestId("week-day-2026-10-07-in-cash")).toHaveTextContent("$30.00");
  });

  it("the week's cash figure says it is a sum of the days", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    const total = await screen.findByTestId("week-total");
    expect(within(total).getByTestId("week-total-cash-expected")).toHaveTextContent(
      "Cash expected in drawer (sum of days)",
    );
    // a single day keeps its own plain label
    expect(
      within(screen.getByTestId("week-day-2026-10-07")).getByTestId(
        "week-day-2026-10-07-cash-expected",
      ),
    ).not.toHaveTextContent("sum of days");
  });

  it("each day's request carries the query's abort signal (a closed sheet cancels the in-flight calls)", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    await waitFor(() => expect(dayCalls()).toHaveLength(7));
    for (const c of dayCalls()) {
      expect((c[1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("'Today' goes back to the list of today's sales", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    await screen.findByTestId("week-total");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByTestId("today-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("week-total")).toBeNull();
  });

  it("Download CSV hands over the days oldest first plus a Total row, named for the range", async () => {
    serveWeek();
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    await screen.findByTestId("week-total");
    const created: Blob[] = [];
    URL.createObjectURL = jest.fn((b: Blob) => (created.push(b), "blob:csv"));
    URL.revokeObjectURL = jest.fn();
    let named = "";
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      named = this.download;
    });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(named).toBe("counter-sales-2026-10-01-to-2026-10-07.csv");
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(created[0]!);
    });
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(9); // header + 7 days + Total
    expect(lines[1]!.startsWith("2026-10-01,")).toBe(true);
    expect(lines[7]!.startsWith("2026-10-07,")).toBe(true);
    expect(lines[8]!.startsWith("Total,14,315.00,")).toBe(true);
    click.mockRestore();
  });

  it("Print prints only this report (the counter screen is hidden for the print) and cleans up", async () => {
    serveWeek();
    const print = jest.fn();
    window.print = print;
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    await screen.findByTestId("week-total");
    expect(document.body.classList.contains("counter-reprint-open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() =>
      expect(document.body.classList.contains("counter-reprint-open")).toBe(false),
    );
  });

  it("a day that fails shows fixed copy with Retry (never the server text), and no partial total", async () => {
    serveWeek("2026-10-04");
    await open();
    await screen.findByTestId("today-summary");
    fireEvent.click(toggle());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the last 7 days.");
    expect(alert.textContent).not.toMatch(/RAW/);
    expect(screen.queryByTestId("week-total")).toBeNull();
    serveWeek(); // the day recovers
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("week-total")).toBeInTheDocument();
  });
});
