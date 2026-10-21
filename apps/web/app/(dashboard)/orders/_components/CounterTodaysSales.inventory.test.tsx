import * as React from "react";
import { renderWithProviders, screen, fireEvent, within } from "@/test-utils/render";
import type { TodaysSaleRow, TodaysSalesResponse, TodaysSalesSummary } from "@routeflow/types";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * UI law: a change to a screen never loses a feature. This pins EVERY control and figure the Today's sales sheet had before the
 * day-close section was added (opener, header Close, summary figures, Reprint, Return items, View order, Show more, Retry, and the
 * reprint view's Print / Back to sales), and that the new Close day section sits beside them rather than replacing any.
 */
const get = jest.fn();
const post = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { role: "OPERATOR", username: "pat" } }),
}));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({
    data: {
      id: "o1",
      orderNumber: "ORD-1",
      customerId: "c1",
      total: 22.5,
      customer: { businessName: "Walk-in" },
      lineItems: [{ id: "l1", name: "Cola", qty: 3, unitPrice: 2.5 }],
    },
  }),
}));
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: () => null,
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
  returned: { amount: 0, state: "NONE", returns: [] },
  voided: false,
  cashTendered: null,
  change: null,
  taxRatePercent: null,
  ...over,
});
const SUMMARY: TodaysSalesSummary = {
  sales: { count: 1, total: 22.5 },
  // every figure non-zero: a $0 extra row is not rendered (R7b 2.4), and this test proves each figure still is
  moneyIn: { cash: 22.5, card: 1, check: 1, other: 1, total: 25.5 },
  handOvers: { count: 1, total: 3 },
  storeCreditUsed: 1,
  onAccount: 1,
  refunds: { count: 1, cash: 1, card: 1, check: 1, other: 1, total: 4, tenderKnown: true },
  storeCreditIssued: { count: 1, amount: 1 },
  cashExpectedInDrawer: 22.5,
  netCollected: 22.5,
};
const page = (over: { totalPages?: number } = {}): TodaysSalesResponse => ({
  data: [row()],
  meta: {
    total: 1,
    page: 1,
    limit: 25,
    totalPages: over.totalPages ?? 1,
    day: "2026-10-07",
    timezone: "America/New_York",
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-08T04:00:00.000Z",
  },
  summary: SUMMARY,
});
const DAY_STATE = {
  registerKey: "main",
  zone: "America/New_York",
  lastClose: null,
  salesSince: 0,
  preview: {
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-07T16:00:00.000Z",
    suggestedOpeningFloat: 0,
    tillCash: 22.5,
    cashRefunds: 0,
    totals: {},
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data: url === "/orders/counter-sale/day-close" ? DAY_STATE : page({ totalPages: 2 }),
    }),
  );
});

it("every control of the Today's sales sheet that existed before day close is still rendered", async () => {
  renderWithProviders(<CounterTodaysSales />);
  // the opener
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  const dialog = await screen.findByRole("dialog", { name: "Today's sales" });
  // the header Close (X)
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  // the summary and every figure on it
  const summary = await within(dialog).findByTestId("today-summary");
  // the disclosure keeps every figure one tap away
  fireEvent.click(within(summary).getByRole("button", { name: "Show all figures" }));
  for (const id of [
    "today-in-cash",
    "today-in-card",
    "today-in-check",
    "today-in-other",
    "today-in-total",
    "today-hand-overs",
    "today-store-credit-used",
    "today-on-account",
    "today-refunds",
    "today-refunds-cash",
    "today-refunds-card",
    "today-refunds-check",
    "today-refunds-other",
    "today-store-credit-issued",
    "today-net-collected",
    "today-cash-expected",
  ]) {
    expect(within(summary).getByTestId(id)).toBeInTheDocument();
  }
  // the sale list and every per-row control
  const r = await within(dialog).findByTestId("today-row-o1");
  expect(within(r).getByRole("button", { name: "Reprint" })).toBeInTheDocument();
  expect(within(r).getByRole("button", { name: "Return items" })).toBeInTheDocument();
  expect(within(r).getByRole("link", { name: "View order" })).toHaveAttribute("href", "/orders/o1");
  // paging
  expect(within(dialog).getByRole("button", { name: "Show more" })).toBeInTheDocument();
  // and the new section is beside them, not instead of them
  expect(within(dialog).getByRole("button", { name: "Close day" })).toBeInTheDocument();
});

it("the reprint view keeps Print and Back to sales", async () => {
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reprint" }));
  expect(await screen.findByRole("button", { name: "Print" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back to sales" })).toBeInTheDocument();
  // the day-close section is part of the list view only
  expect(screen.queryByRole("button", { name: "Close day" })).toBeNull();
});

it("the load-failure view keeps its Retry", async () => {
  get.mockRejectedValue({ response: { data: { message: "boom" } } });
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  expect(await screen.findByText("Could not load today's sales.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("a day-close answer with no preview (an older API) renders nothing extra and breaks nothing", async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/counter-sale/day-close" ? {} : page() }),
  );
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  await screen.findByTestId("today-summary");
  expect(screen.queryByRole("button", { name: "Close day" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reprint" })).toBeInTheDocument();
});
