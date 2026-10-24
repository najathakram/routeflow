import * as React from "react";
import { act, renderWithProviders, screen, fireEvent, waitFor, within } from "@/test-utils/render";
import type { DayCloseSnapshot, DayCloseState, DayCloseTotals } from "@routeflow/types";
import type { TodaysSaleRow, TodaysSalesResponse, TodaysSalesSummary } from "@routeflow/types";
import { DAY_CLOSE_MAX_COUNT } from "@routeflow/pricing";
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
let tenantSlug: string | null = "acme";
jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({
    slug: tenantSlug,
    branding: null,
    isLoading: false,
    refresh: async () => {},
  }),
}));
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
  window.sessionStorage.clear(); // a kept count draft must not leak into the next test
  role = "OPERATOR";
  tenantSlug = "acme";
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
    // nothing counted yet: the hero says so (row 378), never "Short $130.00"
    expect(screen.getByTestId("close-variance")).toHaveTextContent("Not counted yet");
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

  it("labels the variance Balanced / Over / Short in words, not by colour alone", async () => {
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
    expect(v).toHaveTextContent("Short $10.00");
    expect(v.className).toMatch(/red/);
    expect(v.className).not.toMatch(/amber/);
    // one vocabulary: Even, Under and Over/short are gone from the form
    expect(v.textContent).not.toMatch(/Even|Under|Over\/short/);
  });

  it("the variance is the sticky hero, neutral (not red) until the first count entry", async () => {
    await openForm();
    const v = screen.getByTestId("close-variance");
    // nothing counted yet: a plain prompt, no verdict and no alarm colour
    expect(v).toHaveTextContent("Not counted yet");
    expect(v.textContent).not.toMatch(/Short|Over|Balanced/);
    expect(v.className).not.toMatch(/red|amber|green/);
    expect(v.className).toMatch(/text-2xl font-semibold/);
    expect(screen.getByTestId("day-close-variance-hero").className).toMatch(/sticky top-0/);
    setCount("$20 bill", 1);
    expect(v.className).toMatch(/red/);
  });

  it("shows Unpaid pickups, and the tender note only while a refund has no recorded tender", async () => {
    await openForm();
    expect(screen.getByTestId("close-not-at-till")).toHaveTextContent("Unpaid pickups: $12.50");
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
    expect(screen.getByRole("button", { name: "More $20 bill" }).className).toMatch(
      /min-h-\[44px\]/,
    );
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Closed on another device.");
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
    expect(closed).toHaveTextContent("Closed 11:30 AM by Pat · Short $2.00");
    expect(screen.queryByTestId("day-close-form")).toBeNull();
  });
});

describe("CounterDayClose: the closed state", () => {
  const withClose = (over: Partial<DayCloseSnapshot> = {}, since = 3) => {
    dayState = stateOf({ lastClose: snapshot(over), salesSince: since });
  };

  it("shows the close time in the tenant zone, who closed it, the verdict, and the stored figures", async () => {
    withClose();
    await openSheet();
    const closed = await screen.findByTestId("day-close-closed");
    expect(closed).toHaveTextContent("Closed 11:30 AM by Pat · Short $2.00");
    expect(within(closed).getByTestId("closed-sales-since")).toHaveTextContent("3 sales since");
    expect(within(closed).getByTestId("closed-float")).toHaveTextContent("$100.00");
    expect(within(closed).getByTestId("closed-expected")).toHaveTextContent("$130.00");
    expect(within(closed).getByTestId("closed-counted")).toHaveTextContent("$128.00");
    expect(within(closed).getByTestId("closed-variance")).toHaveTextContent("Short $2.00");
  });

  it.each([
    [0, "Closed 11:30 AM by Pat · Balanced"],
    [1, "Closed 11:30 AM by Pat · Over $1.00"],
  ])("a variance of %s reads '%s'", async (variance, text) => {
    withClose({ variance, countedCash: 130 + variance });
    await openSheet();
    expect(await screen.findByTestId("closed-headline")).toHaveTextContent(text);
  });

  it("leaves out 'by ...' when the closer is unknown", async () => {
    withClose({ closedByName: null });
    await openSheet();
    expect(await screen.findByTestId("closed-headline")).toHaveTextContent(
      /^Closed 11:30\sAM · Short \$2\.00$/,
    );
  });

  it("says '1 sale since' for one sale", async () => {
    withClose({}, 1);
    await openSheet();
    expect(await screen.findByTestId("closed-sales-since")).toHaveTextContent("1 sale since");
  });

  it("View Z opens the Z report for the stored close, in the plan's four groups", async () => {
    withClose({ day: "2026-10-07" });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "View Z report" }));
    const dialog = await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    expect(within(dialog).getByTestId("z-headline").textContent).toBe("Short $2.00");
    expect(within(dialog).getByTestId("z-counted")).toHaveTextContent("Counted $128.00");
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Drawer", "Money in", "Credit & account", "Refunds & net"]);
    // the stored expected cash, not a re-derived one
    expect(within(dialog).getByTestId("z-row-Expected cash")).toHaveTextContent("$130.00");
    expect(within(dialog).getByTestId("z-note")).toHaveTextContent("ok");
    // no customer names, no sale lines
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("View Z carries Close, Email and Print (Print last); Close returns to the sheet", async () => {
    withClose({ reportSent: true });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "View Z report" }));
    const z = await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    const actions = within(z).getByTestId("z-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Close", "Email", "Print"]);
    fireEvent.click(within(actions).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("z-report")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Today's sales" })).toBeInTheDocument();
  });

  it("Email in the Z view posts the report route and shows the fixed sent line", async () => {
    withClose({ reportSent: true });
    post.mockResolvedValue({ data: { reportSent: true } });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "View Z report" }));
    const z = await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    fireEvent.click(within(z).getByRole("button", { name: "Email" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/orders/counter-sale/day-close/dc1/report"),
    );
    expect(await within(z).findByTestId("z-resend-status")).toHaveTextContent(
      "Z report emailed to admins",
    );
  });

  it("Escape leaves the Z view first, then the Today's sales sheet", async () => {
    withClose();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "View Z report" }));
    await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("z-report")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Today's sales" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the card, the form and the Z view say the same variance in the same words", async () => {
    withClose({ variance: -2, countedCash: 128 });
    await openSheet();
    expect(await screen.findByTestId("closed-variance")).toHaveTextContent("Short $2.00");
    fireEvent.click(screen.getByRole("button", { name: "View Z report" }));
    const z = await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    expect(within(z).getByTestId("z-headline").textContent).toBe("Short $2.00");
    expect(document.body.textContent).not.toMatch(/Balanced|Under \$|Even \$|Over\/short/);
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

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s sees View Z report and Edit count", async (r) => {
    role = r;
    withClose();
    await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.getByRole("button", { name: "View Z report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit count" })).toBeInTheDocument();
  });

  it.each([undefined, "DRIVER", "CUSTOMER"])(
    "role %s sees View Z report but no Edit count",
    async (r) => {
      role = r;
      withClose();
      await openSheet();
      await screen.findByTestId("day-close-closed");
      expect(screen.getByRole("button", { name: "View Z report" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit count" })).toBeNull();
    },
  );

  it("has no Reopen day button or confirm dialog any more: the reopen path is Edit count", async () => {
    withClose();
    await openSheet();
    await screen.findByTestId("day-close-closed");
    expect(screen.queryByRole("button", { name: "Reopen day" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit count" }));
    await screen.findByTestId("day-close-form");
    expect(screen.queryByRole("dialog", { name: "Reopen this day?" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    // row 345 wording for what an edit does (the owner-ruled sentence R4.2 shipped)
    expect(
      screen.getByText("Sales times stay the same. A corrected Z report is emailed."),
    ).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Close again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close day" })).toBeNull();
    expect(screen.getByTestId("day-close-nothing-new")).toHaveTextContent(
      "Already closed. Nothing new since 11:30 AM.",
    );
    unmount();
    // a refund with no new sale is activity
    dayState = stateOf(
      { lastClose: snapshot({ day: today }), salesSince: 0 },
      { totals: { ...quiet, refunds: { ...quiet.refunds, count: 1, cash: 5, total: 5 } } },
    );
    await openSheet();
    expect(await screen.findByRole("button", { name: "Close again" })).toBeInTheDocument();
    expect(screen.queryByTestId("day-close-nothing-new")).toBeNull();
  });

  it("offers a plain 'Close day' when nothing has been closed yet", async () => {
    await openSheet();
    expect(await screen.findByRole("button", { name: "Close day" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close again" })).toBeNull();
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

  it("Close day is a secondary button", async () => {
    await openSheet();
    const btn = await screen.findByRole("button", { name: "Close day" });
    expect(btn.className).toContain("bg-paper");
    expect(btn.className).not.toContain("bg-accent-strong");
  });

  it("places Close day above the Summary", async () => {
    await openSheet();
    const btn = await screen.findByRole("button", { name: "Close day" });
    const summary = await screen.findByTestId("today-summary");
    expect(btn.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

const draftKeys = () =>
  Object.keys(window.sessionStorage).filter((k) => k.startsWith("rf:dayclose:draft:"));
const pressEscape = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });

describe("CounterDayClose: the drawer count survives a dismissed dialog (R7b 2.3, B1263)", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("closing the form with a typed count and reopening keeps the float and counts", async () => {
    await openForm();
    setFloat("50.00");
    setCount("$20 bill", 2);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "short a five" } });
    pressEscape();
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    await screen.findByTestId("day-close-form");
    expect(screen.getByLabelText("Opening float")).toHaveValue("50.00");
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("2");
    expect(screen.getByLabelText("Notes")).toHaveValue("short a five");
    expect(draftKeys()).toHaveLength(1);
    expect(draftKeys()[0]).toMatch(/^rf:dayclose:draft:[^:]+:main:\d{4}-\d{2}-\d{2}$/);
  });

  it("a dirty close asks Keep or Discard; Discard clears the draft", async () => {
    await openForm();
    setCount("$5 bill", 4);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Keep your count for later?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    expect(draftKeys()).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    await screen.findByTestId("day-close-form");
    expect(screen.getByLabelText("Opening float")).toHaveValue("100.00");
    expect(screen.getByLabelText("$5 bill count")).toHaveValue("0");
  });

  it("typing the suggested float as 100 (not 100.00) is not dirty: no prompt on close (N1)", async () => {
    await openForm();
    setFloat("100");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    expect(screen.queryByText("Keep your count for later?")).toBeNull();
    expect(draftKeys()).toHaveLength(0);
  });

  it("with no tenant known there is no draft: nothing is written under a made-up tenant (N5)", async () => {
    tenantSlug = null;
    await openForm();
    setCount("$20 bill", 2);
    await new Promise((r) => setTimeout(r, 450));
    expect(draftKeys()).toHaveLength(0);
    pressEscape();
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    expect(draftKeys()).toHaveLength(0);
  });

  it("a clean form closes with no question and writes no draft", async () => {
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    expect(screen.queryByText("Keep your count for later?")).toBeNull();
    expect(draftKeys()).toHaveLength(0);
  });

  it("a successful close clears the draft", async () => {
    post.mockResolvedValue({ data: snapshot() });
    await openForm();
    setCount("$20 bill", 2);
    await waitFor(() => expect(draftKeys()).toHaveLength(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(draftKeys()).toHaveLength(0));
  });

  it("the draft key is the window's tenant day: a count typed before midnight is still there after it (I1)", async () => {
    jest.useFakeTimers({
      doNotFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask"],
    });
    try {
      // 23:58 on Oct 7 in New York = 03:58Z on Oct 8; the preview window started that morning
      jest.setSystemTime(new Date("2026-10-08T03:58:00.000Z"));
      await openForm();
      setCount("$20 bill", 2);
      pressEscape();
      fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
      await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
      jest.setSystemTime(new Date("2026-10-08T04:30:00.000Z")); // 00:30 the next tenant day
      fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
      await screen.findByTestId("day-close-form");
      expect(screen.getByLabelText("$20 bill count")).toHaveValue("2");
      expect(draftKeys()[0]).toContain(":2026-10-07");
    } finally {
      jest.useRealTimers();
    }
  });

  it("a seeded form (Edit count) never touches the kept draft (M2)", async () => {
    const first = await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    await screen.findByTestId("day-close-form");
    setCount("$20 bill", 2);
    pressEscape();
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    first.unmount();
    const kept = window.sessionStorage.getItem(draftKeys()[0]!);
    expect(kept).not.toBeNull();
    // a fresh sheet whose state is a reopened close: the seeded form opens, then closes
    dayState = stateOf({ lastClose: snapshot({ reopenedAt: "2026-10-07T16:00:00.000Z" }) });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    await screen.findByLabelText("Opening float (kept from the first close)");
    await new Promise((r) => setTimeout(r, 450)); // long enough for the debounced write to have fired
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("day-close-form")).toBeNull());
    expect(window.sessionStorage.getItem(draftKeys()[0]!)).toBe(kept);
  });

  it("unmounting the sheet under a typed count keeps it, with no confirm (M1)", async () => {
    const r = await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    await screen.findByTestId("day-close-form");
    setCount("$20 bill", 3);
    r.unmount(); // what closing Today's sales or switching to week does to the form
    await openForm();
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("3");
  });

  it("restored counts follow the input's rule: whole, not negative, capped (M3)", async () => {
    window.sessionStorage.setItem(
      "rf:dayclose:draft:acme:main:2026-10-07",
      JSON.stringify({
        v: 1,
        floatText: "100.00",
        notes: "",
        counts: { "bill:20": -3, "bill:10": 2.7, "bill:5": 99999999 },
      }),
    );
    await openForm();
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("0");
    expect(screen.getByLabelText("$10 bill count")).toHaveValue("2");
    expect(
      Number((screen.getByLabelText("$5 bill count") as HTMLInputElement).value),
    ).toBeLessThanOrEqual(DAY_CLOSE_MAX_COUNT);
    expect(screen.getByLabelText("$5 bill count")).not.toHaveValue("99999999");
  });

  it("the form says the Z report is emailed before Close day", async () => {
    await openForm();
    const note = screen.getByText("Closing emails the Z report to admins.");
    expect(
      note.compareDocumentPosition(submitButton()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

const REOPEN_URL = "/orders/counter-sale/day-close/dc1/reopen";
const CLOSE_URL = "/orders/counter-sale/day-close";
const postedUrls = () => post.mock.calls.map((c) => c[0]);

describe("CounterDayClose: a state that is already reopened", () => {
  it("shows Close day with the stored float locked and the stored counts, float and notes prefilled", async () => {
    dayState = stateOf({
      lastClose: snapshot({ reopenedAt: "2026-10-07T16:00:00.000Z" }),
      salesSince: 0,
    });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Close day" }));
    const floatInput = await screen.findByLabelText("Opening float (kept from the first close)");
    expect(floatInput).toHaveValue("100.00");
    expect(floatInput).toHaveAttribute("readonly");
    expect(screen.getByLabelText("$100 bill count")).toHaveValue("1");
    expect(screen.getByLabelText("$1.00 coin count")).toHaveValue("3");
    expect(screen.getByLabelText("$1 bill count")).toHaveValue("0");
    expect(screen.getByLabelText("Notes")).toHaveValue("ok");
  });
});

describe("CounterDayClose: Edit count (reopen, then close again)", () => {
  // the preview after a close describes the NEXT window, so its numbers must not leak into an edit of the closed one
  const closedWithQuietNextWindow = () => {
    dayState = stateOf({ lastClose: snapshot(), salesSince: 0 }, { tillCash: 999 });
  };
  const serveEdit = (closeResult: "ok" | Error | unknown = "ok") =>
    post.mockImplementation((url: string) => {
      if (url === REOPEN_URL) {
        dayState = stateOf({
          lastClose: snapshot({ reopenedAt: "2026-10-07T16:00:00.000Z" }),
          salesSince: 0,
        });
        return Promise.resolve({ data: {} });
      }
      if (closeResult !== "ok") return Promise.reject(closeResult);
      const fixed = snapshot({ countedCash: 133, variance: 3, notes: "ok" });
      dayState = stateOf({ lastClose: fixed, salesSince: 0 });
      return Promise.resolve({ data: fixed });
    });
  const openEdit = async () => {
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Edit count" }));
    return screen.findByTestId("day-close-form");
  };

  it("row 345: the help line says sales times stay the same and a corrected Z report is emailed", async () => {
    closedWithQuietNextWindow();
    await openEdit();
    const dialog = screen.getByRole("dialog", { name: "Edit count" });
    expect(dialog).toHaveTextContent("Sales times stay the same. A corrected Z report is emailed.");
    expect(dialog).not.toHaveTextContent("The window stays the same");
  });

  it("opens the count form prefilled from the stored close, float locked, and posts nothing yet", async () => {
    closedWithQuietNextWindow();
    await openEdit();
    expect(screen.getByRole("dialog", { name: "Edit count" })).toBeInTheDocument();
    const floatInput = screen.getByLabelText("Opening float (kept from the first close)");
    expect(floatInput).toHaveValue("100.00");
    expect(floatInput).toHaveAttribute("readonly");
    expect(screen.getByLabelText("$100 bill count")).toHaveValue("1");
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("1");
    expect(screen.getByLabelText("$5 bill count")).toHaveValue("1");
    expect(screen.getByLabelText("$1.00 coin count")).toHaveValue("3");
    expect(screen.getByLabelText("Notes")).toHaveValue("ok");
    // live figures: counted 128 against the STORED expected 130, not the next window's preview
    expect(screen.getByTestId("close-counted")).toHaveTextContent("$128.00");
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("close-variance")).toHaveTextContent("Short $2.00");
    expect(screen.getByRole("button", { name: "Save count" })).toBeEnabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("Save count posts the reopen, then the close with the kept float, new counts and notes, and refetches", async () => {
    closedWithQuietNextWindow();
    serveEdit();
    await openEdit();
    setCount("$5 bill", 2);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  fixed a five " } });
    expect(screen.getByTestId("close-variance")).toHaveTextContent("Over $3.00");
    const before = stateCalls().length;
    fireEvent.click(screen.getByRole("button", { name: "Save count" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(postedUrls()).toEqual([REOPEN_URL, CLOSE_URL]);
    expect(post).toHaveBeenNthCalledWith(2, CLOSE_URL, {
      openingFloat: 100,
      denominations: [
        { kind: "bill", value: 100, count: 1 },
        { kind: "bill", value: 20, count: 1 },
        { kind: "bill", value: 5, count: 2 },
        { kind: "coin", value: 1, count: 3 },
      ],
      notes: "fixed a five",
    });
    // success: the form closes and the closed card shows the new figures
    const closed = await screen.findByTestId("day-close-closed");
    expect(closed).toHaveTextContent("Closed 11:30 AM by Pat · Over $3.00");
    expect(within(closed).getByTestId("closed-counted")).toHaveTextContent("$133.00");
    expect(screen.queryByTestId("day-close-form")).toBeNull();
    expect(stateCalls().length).toBeGreaterThan(before);
  });

  it("does not reopen first when the first call fails: fixed copy, close never posted, counts kept", async () => {
    closedWithQuietNextWindow();
    post.mockRejectedValue(apiError(403, "FORBIDDEN", "internal detail"));
    await openEdit();
    setCount("$5 bill", 4);
    fireEvent.click(screen.getByRole("button", { name: "Save count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reopen the day. Try again.",
    );
    expect(document.body.textContent).not.toMatch(/internal detail/);
    expect(postedUrls()).toEqual([REOPEN_URL]);
    expect(screen.getByLabelText("$5 bill count")).toHaveValue("4");
    expect(screen.getByRole("button", { name: "Save count" })).toBeEnabled();
  });

  it("reopened but the close failed: 'Day reopened. Close it again.', the form stays open with the counts, and a retry does not reopen twice", async () => {
    closedWithQuietNextWindow();
    serveEdit(apiError(500, "INTERNAL", "stack trace: secret"));
    await openEdit();
    setCount("$5 bill", 2);
    fireEvent.click(screen.getByRole("button", { name: "Save count" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Day reopened. Close it again.");
    expect(document.body.textContent).not.toMatch(/secret/);
    expect(screen.getByTestId("day-close-form")).toBeInTheDocument();
    expect(screen.getByLabelText("$5 bill count")).toHaveValue("2");
    expect(screen.getByLabelText("Notes")).toHaveValue("ok");
    expect(screen.getByRole("button", { name: "Save count" })).toBeEnabled();
    // the stored float is still locked and the stored expected still stands
    expect(screen.getByLabelText("Opening float (kept from the first close)")).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByTestId("close-expected")).toHaveTextContent("$130.00");
    expect(postedUrls()).toEqual([REOPEN_URL, CLOSE_URL]);

    // retry: only the close goes out this time
    serveEdit();
    post.mockClear();
    dayState = stateOf({
      lastClose: snapshot({ reopenedAt: "2026-10-07T16:00:00.000Z" }),
      salesSince: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save count" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(postedUrls()).toEqual([CLOSE_URL]);
    expect(await screen.findByTestId("day-close-closed")).toBeInTheDocument();
  });

  it("posts the reopen and the close once each even when Save count is hit twice", async () => {
    closedWithQuietNextWindow();
    serveEdit();
    await openEdit();
    const save = screen.getByRole("button", { name: "Save count" });
    fireEvent.click(save);
    fireEvent.submit(screen.getByTestId("day-close-form"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(postedUrls()).toEqual([REOPEN_URL, CLOSE_URL]);
  });
});

describe("CounterDayClose: close failures (fixed copy per cause, counts kept)", () => {
  const failWith = async (err: unknown) => {
    post.mockRejectedValue(err);
    await openForm();
    setCount("$20 bill", 3);
    fireEvent.click(submitButton());
    return screen.findByRole("alert");
  };

  it.each([
    ["a 503", apiError(503, "SERVICE_UNAVAILABLE", "pool timeout 10000ms")],
    ["a lock timeout", apiError(409, "LOCK_UNAVAILABLE", "could not obtain lock")],
  ])("%s says a sale is finishing", async (_name, err) => {
    const alert = await failWith(err);
    expect(alert).toHaveTextContent("A sale is finishing. Try again.");
    expect(document.body.textContent).not.toMatch(/pool timeout|could not obtain/);
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("3");
    expect(submitButton()).toBeEnabled();
  });

  it("a network error (no response) keeps the count and says so", async () => {
    const alert = await failWith(new Error("Network Error"));
    expect(alert).toHaveTextContent("Couldn't close the day. Your count is still here.");
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("3");
    expect(submitButton()).toBeEnabled();
  });

  it("anything else shows the generic fixed copy", async () => {
    const alert = await failWith(apiError(400, "BAD", "validation: secret"));
    expect(alert).toHaveTextContent("Could not close the day. Check the connection and try again.");
    expect(document.body.textContent).not.toMatch(/secret/);
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("3");
  });

  it("DAY_ALREADY_CLOSED keeps the count and offers View Z, which loads the latest close and opens it", async () => {
    post.mockImplementation(() => {
      // the other device's close is what the refetch will return
      dayState = stateOf({ lastClose: snapshot({ closedByName: "Sam" }), salesSince: 0 });
      return Promise.reject(apiError(409, "DAY_ALREADY_CLOSED", "PG boom"));
    });
    await openForm();
    setCount("$20 bill", 3);
    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Closed on another device.");
    expect(screen.getByLabelText("$20 bill count")).toHaveValue("3");
    const before = stateCalls().length;
    fireEvent.click(within(alert).getByRole("button", { name: "View Z report" }));
    const z = await screen.findByRole("dialog", { name: "Z report · Wed, Oct 7" });
    expect(stateCalls().length).toBeGreaterThan(before);
    expect(within(z).getByTestId("z-closed-line")).toHaveTextContent("Closed 11:30 AM by Sam");
    expect(screen.queryByTestId("day-close-form")).toBeNull();
  });

  it("only DAY_ALREADY_CLOSED offers View Z in the form", async () => {
    const alert = await failWith(apiError(500, "INTERNAL"));
    expect(within(alert).queryByRole("button", { name: "View Z report" })).toBeNull();
  });
});

describe("CounterDayClose: offline", () => {
  const setOnline = (v: boolean) => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: v });
    act(() => {
      window.dispatchEvent(new Event(v ? "online" : "offline"));
    });
  };
  afterEach(() => setOnline(true));

  it("disables Close day and says the count stays here, then re-enables when the connection returns", async () => {
    setOnline(false);
    await openForm();
    expect(screen.getByTestId("day-close-offline")).toHaveTextContent(
      "You're offline. Your count stays here.",
    );
    expect(submitButton()).toBeDisabled();
    fireEvent.submit(screen.getByTestId("day-close-form"));
    expect(post).not.toHaveBeenCalled();
    setOnline(true);
    expect(screen.queryByTestId("day-close-offline")).toBeNull();
    expect(submitButton()).toBeEnabled();
  });

  it("Save count is disabled offline too", async () => {
    dayState = stateOf({ lastClose: snapshot(), salesSince: 0 });
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Edit count" }));
    await screen.findByTestId("day-close-form");
    setOnline(false);
    expect(screen.getByRole("button", { name: "Save count" })).toBeDisabled();
    expect(screen.getByTestId("day-close-offline")).toBeInTheDocument();
  });
});

describe("CounterDayClose: phone layout", () => {
  it("every button and input on the closed card and in the edit form is a 44px target", async () => {
    dayState = stateOf({ lastClose: snapshot({ reportSent: false }), salesSince: 0 });
    await openSheet();
    const card = await screen.findByTestId("day-close-closed");
    for (const name of ["Resend", "View Z report", "Edit count"]) {
      expect(within(card).getByRole("button", { name }).className).toMatch(/min-h-\[44px\]/);
    }
    fireEvent.click(within(card).getByRole("button", { name: "Edit count" }));
    const form = await screen.findByTestId("day-close-form");
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs[dialogs.length - 1].className).toMatch(/h-\[100dvh\]/);
    for (const name of ["Save count", "Cancel"]) {
      expect(within(form).getByRole("button", { name }).className).toMatch(/min-h-\[44px\]/);
    }
    expect(within(form).getByLabelText("$20 bill count").className).toMatch(/h-11/);
    expect(
      within(form).getByLabelText("Opening float (kept from the first close)").className,
    ).toMatch(/h-11/);
    expect(within(form).getByRole("button", { name: "More $20 bill" }).className).toMatch(
      /min-h-\[44px\]/,
    );
  });
});
