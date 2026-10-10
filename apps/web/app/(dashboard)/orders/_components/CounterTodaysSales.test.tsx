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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => addon }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username: "pat" } : null }),
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

  it("Reprint opens the shared receipt view: 'Reprint · sold …', no Tendered or Change", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
    const root = await screen.findByTestId("receipt-print-root");
    expect(within(root).getByTestId("receipt-reprint")).toHaveTextContent(
      /^Reprint · sold .*11:15 AM/,
    );
    expect(within(root).getByTestId("receipt-numbers")).toHaveTextContent("Order ORD-1");
    expect(within(root).getByTestId("receipt-total")).toHaveTextContent("$22.50");
    expect(within(root).getByTestId("receipt-method")).toHaveTextContent("Cash");
    expect(root.textContent).not.toMatch(/Tendered|Change/);
    fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
    expect(await screen.findByTestId("today-row-o1")).toBeInTheDocument();
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

  it("a reprint credits the reprinter, never a Cashier line", async () => {
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
