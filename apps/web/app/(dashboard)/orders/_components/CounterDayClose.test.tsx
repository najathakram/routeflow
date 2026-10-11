import * as React from "react";
import { act, renderWithProviders, screen, fireEvent, waitFor, within } from "@/test-utils/render";
import type { DayCloseSnapshot, DayCloseState, DayCloseTotals } from "@routeflow/pricing";
import type { TodaysSaleRow, TodaysSalesResponse, TodaysSalesSummary } from "@routeflow/types";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * SA-750: the end-of-day close in the Today's sales sheet. The API is mocked at the apiClient boundary; the figures in the form are
 * a PREVIEW (the server recomputes), so every number asserted here comes from the mocked preview plus the typed counts.
 */
const get = jest.fn();
const post = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
let role: string | undefined = "OPERATOR";
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username: "pat" } : null }),
}));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({
    data: {
      id: "o1",
      orderNumber: "ORD-1",
      customerId: "c1",
      total: 22.5,
      customer: { businessName: "Walk-in" },
      lineItems: [],
    },
  }),
}));
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: () => null,
}));

const TOTALS: DayCloseTotals = {
  salesCount: 2,
  salesTotal: 45,
  moneyIn: { cash: 30, card: 15, check: 0, other: 0, total: 45 },
  refunds: {
    count: 0,
    cash: 0,
    card: 0,
    check: 0,
    other: 0,
    total: 0,
    tenderKnown: true,
    unknownTenderCount: 0,
  },
  storeCreditUsed: 0,
  storeCreditIssued: { count: 0, amount: 0 },
  onAccount: 0,
  netCollected: 45,
  notAtTill: 12.5,
};
const snapshot = (over: Partial<DayCloseSnapshot> = {}): DayCloseSnapshot => ({
  id: "dc1",
  registerKey: "main",
  day: "2026-10-07",
  zone: "America/New_York",
  windowStart: "2026-10-07T04:00:00.000Z",
  windowEnd: "2026-10-07T15:30:00.000Z",
  closedAt: "2026-10-07T15:30:00.000Z",
  closedById: "u1",
  closedByName: "Pat",
  openingFloat: 100,
  expectedCash: 130,
  countedCash: 128,
  variance: -2,
  denominations: [
    { kind: "bill", value: 100, count: 1 },
    { kind: "bill", value: 20, count: 1 },
    { kind: "bill", value: 5, count: 1 },
    { kind: "coin", value: 1, count: 3 },
  ],
  totals: TOTALS,
  notes: "ok",
  reopenedAt: null,
  reopenedById: null,
  reportSent: true,
  ...over,
});
const stateOf = (
  over: Partial<DayCloseState> = {},
  preview: Partial<DayCloseState["preview"]> = {},
) =>
  ({
    registerKey: "main",
    zone: "America/New_York",
    lastClose: null,
    salesSince: 0,
    preview: {
      windowStart: "2026-10-07T04:00:00.000Z",
      windowEnd: "2026-10-07T16:00:00.000Z",
      suggestedOpeningFloat: 100,
      tillCash: 30,
      cashRefunds: 0,
      totals: TOTALS,
      ...preview,
    },
    ...over,
  }) as DayCloseState;

const SUMMARY: TodaysSalesSummary = {
  sales: { count: 2, total: 45 },
  moneyIn: { cash: 30, card: 15, check: 0, other: 0, total: 45 },
  handOvers: { count: 0, total: 0 },
  storeCreditUsed: 0,
  onAccount: 0,
  refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: true },
  storeCreditIssued: { count: 0, amount: 0 },
  cashExpectedInDrawer: 30,
  netCollected: 45,
};
const todayPage = (rows: TodaysSaleRow[] = []): TodaysSalesResponse => ({
  data: rows,
  meta: {
    total: rows.length,
    page: 1,
    limit: 25,
    totalPages: 1,
    day: "2026-10-07",
    timezone: "America/New_York",
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-08T04:00:00.000Z",
  },
  summary: SUMMARY,
});

let dayState: DayCloseState;
const serve = () =>
  get.mockImplementation((url: string) => {
    if (url === "/orders/counter-sale/today") return Promise.resolve({ data: todayPage() });
    if (url === "/orders/counter-sale/day-close") return Promise.resolve({ data: dayState });
    return Promise.resolve({ data: {} });
  });
const stateCalls = () => get.mock.calls.filter((c) => c[0] === "/orders/counter-sale/day-close");
const openSheet = async () => {
  const r = renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  return r;
};
const openForm = async () => {
  await openSheet();
  fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
  return screen.findByTestId("day-close-form");
};
const setFloat = (v: string) =>
  fireEvent.change(screen.getByLabelText("Opening float"), { target: { value: v } });
const setCount = (label: string, n: number) =>
  fireEvent.change(screen.getByLabelText(`${label} count`), { target: { value: String(n) } });
const submitButton = () =>
  screen.getByRole("button", { name: /close day|closing/i, hidden: false });
const apiError = (status: number, code: string, message = "server says no") => ({
  response: { status, data: { code, message } },
});

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  dayState = stateOf();
  serve();
});

describe("CounterDayClose: the form", () => {
  it("prefills the float from the preview and shows the Counted / Expected / Variance figures", async () => {
    await openForm();
    expect(screen.getByLabelText("Opening float")).toHaveValue("100.00");
    expect(screen.getByTestId("close-counted")).toHaveTextContent("$0.00");
    // expected = 100 + 30 - 0
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("close-variance")).toHaveTextContent("Under $130.00");
  });

  it("has a row per denomination, the $1 bill and the $1 coin distinct", async () => {
    await openForm();
    for (const l of ["$100", "$50", "$20", "$10", "$5", "$2", "$1"]) {
      expect(screen.getByLabelText(`${l} bill count`)).toBeInTheDocument();
    }
    for (const l of ["$1.00", "$0.25", "$0.10", "$0.05", "$0.01"]) {
      expect(screen.getByLabelText(`${l} coin count`)).toBeInTheDocument();
    }
    setCount("$1 bill", 2);
    setCount("$1.00 coin", 3);
    expect(screen.getByTestId("close-counted")).toHaveTextContent("$5.00");
  });

  it("rounds 0.10 x 3 to 0.30 in the counted and the expected figure (no float noise)", async () => {
    dayState = stateOf({}, { suggestedOpeningFloat: 0.2, tillCash: 0.1 });
    await openForm();
    setCount("$0.10 coin", 3);
    expect(screen.getByTestId("close-row-coin:0.1")).toHaveTextContent("$0.30");
    expect(screen.getByTestId("close-counted")).toHaveTextContent("$0.30");
    // 0.2 + 0.1 is 0.30000000000000004 in floating point
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$0.30");
    expect(screen.getByTestId("close-variance")).toHaveTextContent("Balanced");
    expect(document.body.textContent).not.toMatch(/0\.30000/);
  });

  it("subtracts cash refunds from the expected figure", async () => {
    dayState = stateOf({}, { tillCash: 30, cashRefunds: 7.25 });
    await openForm();
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$122.75");
  });

  it("labels the variance Balanced / Over / Under in words, not by colour alone", async () => {
    await openForm();
    setCount("$100 bill", 1);
    setCount("$20 bill", 1);
    setCount("$10 bill", 1);
    expect(screen.getByTestId("close-counted")).toHaveTextContent("$130.00");
    const v = screen.getByTestId("close-variance");
    expect(v).toHaveTextContent("Balanced");
    setCount("$5 bill", 1);
    expect(v).toHaveTextContent("Over $5.00");
    expect(v.className).toMatch(/amber/);
    setCount("$5 bill", 0);
    setCount("$10 bill", 0);
    expect(v).toHaveTextContent("Under $10.00");
    expect(v.className).toMatch(/red/);
    expect(v.className).not.toMatch(/amber/);
  });

  it("shows Not taken at the till, and the tender note only while a refund has no recorded tender", async () => {
    await openForm();
    expect(screen.getByTestId("close-not-at-till")).toHaveTextContent(
      "Not taken at the till: $12.50",
    );
    expect(screen.queryByTestId("close-tender-note")).toBeNull();
  });

  it("notes that refunds with no recorded tender are not subtracted", async () => {
    dayState = stateOf(
      {},
      {
        totals: {
          ...TOTALS,
          refunds: {
            ...TOTALS.refunds,
            count: 1,
            other: 4,
            total: 4,
            tenderKnown: false,
            unknownTenderCount: 1,
          },
        },
      },
    );
    await openForm();
    expect(screen.getByTestId("close-tender-note")).toHaveTextContent(
      "Some refunds have no recorded tender and are not subtracted",
    );
  });

  it("clamps a count to 0..100000 and strips non-digits; notes stop at 500", async () => {
    await openForm();
    const input = screen.getByLabelText("$20 bill count");
    fireEvent.change(input, { target: { value: "9999999" } });
    expect(input).toHaveValue("100000");
    fireEvent.change(input, { target: { value: "1a2" } });
    expect(input).toHaveValue("12");
    fireEvent.click(screen.getByRole("button", { name: "Fewer $20 bill" }));
    expect(input).toHaveValue("11");
    fireEvent.click(screen.getByRole("button", { name: "More $20 bill" }));
    expect(input).toHaveValue("12");
    expect(screen.getByLabelText("Notes")).toHaveAttribute("maxlength", "500");
  });

  it("is full-screen on a phone and its steppers are 44px targets", async () => {
    await openForm();
    const dialogs = screen.getAllByRole("dialog");
    const form = dialogs[dialogs.length - 1];
    expect(form.className).toMatch(/h-\[100dvh\]/);
    expect(form.className).toMatch(/w-screen/);
    expect(screen.getByRole("button", { name: "More $20 bill" }).className).toMatch(/min-h-11/);
    expect(screen.getByLabelText("$20 bill count").className).toMatch(/h-11/);
    expect(screen.getByLabelText("$20 bill count")).toHaveAttribute("inputmode", "numeric");
  });
});

describe("CounterDayClose: submit", () => {
  it("disables submit while the float is invalid, and enables it again once valid", async () => {
    await openForm();
    for (const bad of ["", "abc", "1.234", "-5"]) {
      setFloat(bad);
      expect(submitButton()).toBeDisabled();
    }
    setFloat("50.5");
    expect(submitButton()).toBeEnabled();
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$80.50");
  });

  it("sends the float, the non-zero denominations and trimmed notes, never a counted or expected figure", async () => {
    post.mockResolvedValue({ data: snapshot() });
    await openForm();
    setFloat("100");
    setCount("$20 bill", 2);
    setCount("$0.10 coin", 3);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  short a twenty  " } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/orders/counter-sale/day-close", {
      openingFloat: 100,
      denominations: [
        { kind: "bill", value: 20, count: 2 },
        { kind: "coin", value: 0.1, count: 3 },
      ],
      notes: "short a twenty",
    });
  });

  it("is disabled while the close is in flight and posts only once", async () => {
    post.mockImplementation(() => new Promise(() => {}));
    await openForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toBeDisabled());
    fireEvent.click(submitButton());
    fireEvent.submit(screen.getByTestId("day-close-form"));
    // let any second call reach the network layer before counting
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("DAY_ALREADY_CLOSED shows the fixed copy, never the server text, and re-enables submit", async () => {
    post.mockRejectedValue(apiError(409, "DAY_ALREADY_CLOSED", "PG boom: unique violation"));
    await openForm();
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This day was already closed. Refresh to see it.",
    );
    expect(document.body.textContent).not.toMatch(/PG boom/);
    expect(submitButton()).toBeEnabled();
  });

  it("any other failure shows generic fixed copy, never the server text", async () => {
    post.mockRejectedValue(apiError(500, "INTERNAL", "stack trace: secret"));
    await openForm();
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not close the day. Check the connection and try again.",
    );
    expect(document.body.textContent).not.toMatch(/secret/);
  });

  it("a successful close shows the closed state in the sheet", async () => {
    post.mockImplementation(() => {
      dayState = stateOf({ lastClose: snapshot(), salesSince: 0 });
      return Promise.resolve({ data: snapshot() });
    });
    await openForm();
    fireEvent.click(submitButton());
    const closed = await screen.findByTestId("day-close-closed");
    expect(closed).toHaveTextContent("Closed at 11:30 AM EDT · 0 sales since");
    expect(screen.queryByTestId("day-close-form")).toBeNull();
  });
});

describe("CounterDayClose: the closed state", () => {
  const withClose = (over: Partial<DayCloseSnapshot> = {}, since = 3) => {
    dayState = stateOf({ lastClose: snapshot(over), salesSince: since });
  };

  it("shows the close time in the tenant zone, the sales since, and the stored figures", async () => {
    withClose();
    await openSheet();
    const closed = await screen.findByTestId("day-close-closed");
    expect(closed).toHaveTextContent("Closed at 11:30 AM EDT · 3 sales since");
    expect(within(closed).getByTestId("closed-float")).toHaveTextContent("$100.00");
    expect(within(closed).getByTestId("closed-expected")).toHaveTextContent("$130.00");
    expect(within(closed).getByTestId("closed-counted")).toHaveTextContent("$128.00");
    expect(within(closed).getByTestId("closed-variance")).toHaveTextContent("Under $2.00");
  });

  it("says '1 sale since' for one sale", async () => {
    withClose({}, 1);
    await openSheet();
    expect(await screen.findByTestId("day-close-closed")).toHaveTextContent("1 sale since");
  });

  it("shows 'Report not sent' with Resend only when reportSent === false", async () => {
    withClose({ reportSent: false });
    await openSheet();
    expect(await screen.findByTestId("closed-report-not-sent")).toHaveTextContent(
      "Report not sent",
    );
    expect(screen.getByRole("button", { name: "Resend" })).toBeInTheDocument();
  });

  it.each([true, null] as const)("has no Resend when reportSent is %s", async (sent) => {
    withClose({ reportSent: sent });
    await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
    expect(screen.queryByTestId("closed-report-not-sent")).toBeNull();
  });

  it("Resend posts to the report route and refetches the state", async () => {
    withClose({ reportSent: false });
    post.mockImplementation(() => {
      dayState = stateOf({ lastClose: snapshot({ reportSent: true }), salesSince: 3 });
      return Promise.resolve({ data: {} });
    });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Resend" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/orders/counter-sale/day-close/dc1/report"),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend" })).toBeNull());
    expect(stateCalls().length).toBeGreaterThan(1);
  });

  it("a failed Resend shows fixed copy", async () => {
    withClose({ reportSent: false });
    post.mockRejectedValue(apiError(500, "X", "smtp password wrong"));
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the report. Try again.",
    );
    expect(document.body.textContent).not.toMatch(/smtp password/);
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s sees Reopen day", async (r) => {
    role = r;
    withClose();
    await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.getByRole("button", { name: "Reopen day" })).toBeInTheDocument();
  });

  it.each([undefined, "DRIVER", "CUSTOMER"])("role %s sees no Reopen day", async (r) => {
    role = r;
    withClose();
    await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.queryByRole("button", { name: "Reopen day" })).toBeNull();
  });

  it("Reopen asks first, then posts to the reopen route and offers the form again", async () => {
    withClose({ day: "2000-01-01" });
    post.mockImplementation(() => {
      dayState = stateOf({ lastClose: snapshot({ reopenedAt: "2026-10-07T16:00:00.000Z" }) });
      return Promise.resolve({ data: {} });
    });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Reopen day" }));
    expect(post).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog", { name: "Reopen this day?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Reopen day" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/orders/counter-sale/day-close/dc1/reopen"),
    );
    await waitFor(() => expect(screen.queryByTestId("day-close-closed")).toBeNull());
    // the re-close form starts from the stored float, counts and notes
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    const floatInput = await screen.findByLabelText("Opening float (kept from the first close)");
    expect(floatInput).toHaveValue("100.00");
    expect(floatInput).toHaveAttribute("readonly");
    expect(screen.getByLabelText("$100 bill count")).toHaveValue("1");
    expect(screen.getByLabelText("$1.00 coin count")).toHaveValue("3");
    expect(screen.getByLabelText("$1 bill count")).toHaveValue("0");
    expect(screen.getByLabelText("Notes")).toHaveValue("ok");
  });

  it("Cancel in the Reopen confirm posts nothing", async () => {
    withClose();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Reopen day" }));
    const confirm = await screen.findByRole("dialog", { name: "Reopen this day?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("a failed Reopen shows fixed copy", async () => {
    withClose();
    post.mockRejectedValue(apiError(403, "FORBIDDEN", "internal detail"));
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Reopen day" }));
    const confirm = await screen.findByRole("dialog", { name: "Reopen this day?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Reopen day" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reopen the day. Try again.",
    );
    expect(document.body.textContent).not.toMatch(/internal detail/);
  });

  it("offers no second close for a quiet window on the same day, but does once anything happened", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "America/New_York",
    }).format(new Date());
    const quiet = {
      ...TOTALS,
      salesCount: 0,
      salesTotal: 0,
      moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
      refunds: { ...TOTALS.refunds, count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0 },
      storeCreditUsed: 0,
      storeCreditIssued: { count: 0, amount: 0 },
      notAtTill: 0,
    };
    dayState = stateOf({ lastClose: snapshot({ day: today }), salesSince: 0 }, { totals: quiet });
    const { unmount } = await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.queryByRole("button", { name: "Close day" })).toBeNull();
    unmount();
    // a refund with no new sale is activity
    dayState = stateOf(
      { lastClose: snapshot({ day: today }), salesSince: 0 },
      { totals: { ...quiet, refunds: { ...quiet.refunds, count: 1, cash: 5, total: 5 } } },
    );
    await openSheet();
    expect(await screen.findByRole("button", { name: "Close day" })).toBeInTheDocument();
  });
});

describe("CounterDayClose: loading and failure", () => {
  it("a failed state read shows a Retry and leaves the rest of the sheet alone", async () => {
    get.mockImplementation((url: string) =>
      url === "/orders/counter-sale/day-close"
        ? Promise.reject(apiError(500, "X", "PG boom"))
        : Promise.resolve({ data: todayPage() }),
    );
    await openSheet();
    expect(await screen.findByTestId("day-close-error")).toHaveTextContent(
      "Could not load the day close.",
    );
    expect(document.body.textContent).not.toMatch(/PG boom/);
    expect(screen.getByTestId("today-summary")).toBeInTheDocument();
    dayState = stateOf();
    serve();
    fireEvent.click(
      within(screen.getByTestId("day-close-error")).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByRole("button", { name: "Close day" })).toBeInTheDocument();
  });

  it("places Close day above the Summary", async () => {
    await openSheet();
    const btn = await screen.findByRole("button", { name: "Close day" });
    const summary = await screen.findByTestId("today-summary");
    expect(btn.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
