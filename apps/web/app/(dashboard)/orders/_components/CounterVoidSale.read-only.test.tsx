import * as React from "react";
import type { SubscriptionView, TodaysSaleRow, TodaysSalesResponse } from "@routeflow/types";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * CQ-34: in a READ-ONLY workspace the Today's sales "Void sale" control is disabled UP FRONT with the shared read-only line
 * (as both Complete buttons are), so the clerk is not walked through the dialog and a reason before the server refuses.
 * An ACTIVE workspace is unchanged. The role gate is the real staffMay(role, "VOID_SALE").
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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { role: "OPERATOR", username: "pat" } }),
}));
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));

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
const page = (rows: TodaysSaleRow[]): TodaysSalesResponse => ({
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
  summary: null,
});
const serve = (rows: () => TodaysSaleRow[]) =>
  get.mockImplementation((url: string) =>
    url === "/orders/counter-sale/today"
      ? Promise.resolve({ data: page(rows()) })
      : Promise.resolve({ data: {} }),
  );

const view = (status: "ACTIVE" | "READ_ONLY") =>
  ({ status, billingContactName: "Dana" }) as unknown as SubscriptionView;

const openSheet = async (status: "ACTIVE" | "READ_ONLY") => {
  renderWithProviders(
    <ReadOnlyGateProvider view={view(status)}>
      <CounterTodaysSales />
    </ReadOnlyGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  await screen.findByText("ORD-1");
};
const voidButton = () => screen.getByRole("button", { name: "Void sale ORD-1" });

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    url === "/orders/counter-sale/today"
      ? Promise.resolve({ data: page([row()]) })
      : Promise.resolve({ data: {} }),
  );
});

describe("Void sale in a read-only workspace (CQ-34)", () => {
  it("is disabled, says why, and a click does not open the dialog", async () => {
    await openSheet("READ_ONLY");
    const btn = voidButton();
    expect(btn).toBeDisabled();
    const line = screen.getByTestId("today-read-only-line");
    expect(line.textContent?.length).toBeGreaterThan(0);
    expect(btn).toHaveAttribute("aria-describedby", line.id);
    expect(btn).toHaveAttribute("title", line.textContent as string);
    fireEvent.click(btn);
    expect(screen.queryByLabelText("Reason for voiding")).toBeNull();
    expect(screen.queryByRole("button", { name: "Void sale" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("an ACTIVE workspace: enabled, undescribed, no line, and it opens the dialog", async () => {
    await openSheet("ACTIVE");
    const btn = voidButton();
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("today-read-only-line")).toBeNull();
    fireEvent.click(btn);
    expect(await screen.findByLabelText("Reason for voiding")).toBeInTheDocument();
  });
});
