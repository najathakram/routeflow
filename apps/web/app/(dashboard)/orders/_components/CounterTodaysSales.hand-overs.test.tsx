import * as React from "react";
import { renderWithProviders, screen, fireEvent, within } from "@/test-utils/render";
import type {
  TodaysHandOverRow,
  TodaysSaleRow,
  TodaysSalesResponse,
  TodaysSalesSummary,
} from "@routeflow/types";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * Row 342: the "Pickup hand-overs" section of the Today's sales sheet. The server owns every figure (the same hand-overs the day
 * close counts); the sheet only lists them: order, customer, tender (amount + method), time, register and cashier. A counter sale
 * never appears there, and an older API (no `handOverRows`) shows no section while the Summary line still carries the count.
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
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: () => null,
}));

const sale = (): TodaysSaleRow => ({
  orderId: "o-sale",
  invoiceId: "i1",
  orderNumber: "ORD-SALE",
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
});
const handOver = (over: Partial<TodaysHandOverRow> = {}): TodaysHandOverRow => ({
  orderId: "o-h1",
  orderNumber: "ORD-H1",
  customerName: "Acme Retail",
  paidAt: "2026-10-07T15:15:00.000Z",
  amount: 20,
  methods: [{ method: "CASH", amount: 20 }],
  registerKey: "main",
  handedOverBy: "Pat",
  ...over,
});
const summary = (handOvers: { count: number; total: number }): TodaysSalesSummary => ({
  sales: { count: 1, total: 22.5 },
  moneyIn: { cash: 42.5, card: 25, check: 0, other: 0, total: 67.5 },
  handOvers,
  storeCreditUsed: 0,
  onAccount: 0,
  refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: true },
  storeCreditIssued: { count: 0, amount: 0 },
  cashExpectedInDrawer: 42.5,
  netCollected: 67.5,
});
const page = (
  handOvers: { count: number; total: number },
  handOverRows?: TodaysHandOverRow[],
): TodaysSalesResponse => ({
  data: [sale()],
  meta: {
    total: 1,
    page: 1,
    limit: 25,
    totalPages: 1,
    day: "2026-10-07",
    timezone: "America/New_York",
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-08T04:00:00.000Z",
  },
  summary: summary(handOvers),
  ...(handOverRows ? { handOverRows } : {}),
});
const serve = (res: TodaysSalesResponse) =>
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/counter-sale/day-close" ? {} : res }),
  );
const openSheet = async () => {
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  return screen.findByRole("dialog", { name: "Today's sales" });
};

beforeEach(() => jest.clearAllMocks());

const TWO = [
  handOver(),
  handOver({
    orderId: "o-h2",
    orderNumber: "ORD-H2",
    customerName: "Beta Foods",
    paidAt: "2026-10-07T18:40:00.000Z",
    amount: 25,
    methods: [
      { method: "CASH", amount: 5 },
      { method: "CARD", amount: 20 },
    ],
    registerKey: "front",
    handedOverBy: null,
  }),
];

it("lists each hand-over under the Summary with order link, customer, tender, time and register", async () => {
  serve(page({ count: 2, total: 45 }, TWO));
  const dialog = await openSheet();
  const heading = await within(dialog).findByRole("heading", {
    name: "Pickup hand-overs · 2 · $45.00",
  });
  const section = heading.closest("section") as HTMLElement;
  const r1 = within(section).getByTestId("hand-over-row-o-h1");
  expect(within(r1).getByRole("link", { name: "ORD-H1" })).toHaveAttribute("href", "/orders/o-h1");
  expect(r1).toHaveTextContent("Acme Retail");
  expect(r1).toHaveTextContent("$20.00");
  expect(r1).toHaveTextContent("Cash");
  expect(r1).toHaveTextContent("11:15 AM");
  expect(r1).toHaveTextContent("Register main · Handed over by Pat");
  const r2 = within(section).getByTestId("hand-over-row-o-h2");
  expect(within(r2).getByRole("link", { name: "ORD-H2" })).toHaveAttribute("href", "/orders/o-h2");
  expect(r2).toHaveTextContent("Beta Foods");
  expect(r2).toHaveTextContent("$25.00");
  expect(r2).toHaveTextContent("Cash $5.00 + Card $20.00");
  expect(r2).toHaveTextContent("2:40 PM");
  // no cashier stamped: the register is still shown, the "Handed over by" part is omitted
  expect(r2).toHaveTextContent("Register front");
  expect(r2).not.toHaveTextContent("Handed over by");
  // the counter sale stays in the sale list, never in this section
  expect(within(section).queryByTestId("today-row-o-sale")).toBeNull();
  expect(within(dialog).getByTestId("today-row-o-sale")).toBeInTheDocument();
});

it("the Summary carries a Pickup hand-overs line with the count, the money and the already-included note", async () => {
  serve(page({ count: 2, total: 45 }, TWO));
  const dialog = await openSheet();
  const line = await within(dialog).findByTestId("today-hand-overs");
  expect(line).toHaveTextContent("Pickup hand-overs");
  expect(line).toHaveTextContent("2 · $45.00");
  expect(line).toHaveTextContent("already counted in money in and cash expected");
  // beside Money in, inside the same summary
  const summaryEl = within(dialog).getByTestId("today-summary");
  expect(within(summaryEl).getByTestId("today-in-total")).toBeInTheDocument();
  expect(summaryEl).toContainElement(line);
});

it("no hand-overs: the section is hidden and the Summary line reads 0 · $0.00, never a dash", async () => {
  serve(page({ count: 0, total: 0 }, []));
  const dialog = await openSheet();
  const line = await within(dialog).findByTestId("today-hand-overs");
  expect(line).toHaveTextContent("0 · $0.00");
  expect(line).not.toHaveTextContent("—");
  expect(within(dialog).queryByRole("heading", { name: /Pickup hand-overs/ })).toBeNull();
  expect(within(dialog).queryByRole("list", { name: "Pickup hand-overs" })).toBeNull();
});

it("an older API (no handOverRows): no section, the Summary line still shows the count and total", async () => {
  serve(page({ count: 2, total: 45 }));
  const dialog = await openSheet();
  const line = await within(dialog).findByTestId("today-hand-overs");
  expect(line).toHaveTextContent("2 · $45.00");
  expect(within(dialog).queryByRole("heading", { name: /Pickup hand-overs/ })).toBeNull();
  expect(within(dialog).queryByRole("list", { name: "Pickup hand-overs" })).toBeNull();
});

it("is a phone-width list: 44px targets, wrapping rows, no horizontal overflow", async () => {
  serve(page({ count: 2, total: 45 }, TWO));
  const dialog = await openSheet();
  const list = await within(dialog).findByRole("list", { name: "Pickup hand-overs" });
  expect(list.className).not.toMatch(/overflow-x|whitespace-nowrap/);
  for (const id of ["o-h1", "o-h2"]) {
    const row = within(list).getByTestId(`hand-over-row-${id}`);
    expect(row.className).not.toMatch(/overflow-x|whitespace-nowrap|\bw-\[/);
    expect(row.innerHTML).not.toMatch(/overflow-x|whitespace-nowrap/);
    expect(within(row).getByRole("link").className).toMatch(/\bmin-h-11\b/);
    // the second line wraps rather than pushing the sheet sideways
    expect(row.querySelector("p")?.className).toMatch(/break-words|min-w-0/);
  }
});

it("is a Today-only section: the Last 7 days view does not render it", async () => {
  serve(page({ count: 2, total: 45 }, TWO));
  const dialog = await openSheet();
  await within(dialog).findByRole("heading", { name: /Pickup hand-overs/ });
  fireEvent.click(within(dialog).getByRole("button", { name: "Last 7 days" }));
  await within(dialog).findByTestId("week-total");
  expect(within(dialog).queryByRole("list", { name: "Pickup hand-overs" })).toBeNull();
  expect(within(dialog).queryByRole("heading", { name: /^Pickup hand-overs ·/ })).toBeNull();
});
