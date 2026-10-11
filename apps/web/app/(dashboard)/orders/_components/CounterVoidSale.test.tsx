import * as React from "react";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "@/test-utils/render";
import type { TodaysSaleRow, TodaysSalesResponse } from "@routeflow/types";
import { COUNTER_VOID_ERROR_CODES, COUNTER_VOID_ERROR_COPY } from "@/lib/counter-void-copy";
import { CounterTodaysSales } from "./CounterTodaysSales";

/**
 * SA-762r (Web-1): "Void sale" on a Today's-sales row. The API is mocked at the apiClient boundary. The role gate is the REAL
 * staffMay(role, "VOID_SALE"); the amounts shown are the server's `handBack`; every refusal is fixed copy by `body.code`.
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
let role: string | undefined = "OPERATOR";
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username: "pat" } : null }),
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

const RAW = "RAW SERVER TEXT: pg constraint foo_bar";
const reject = (status: number, code?: string) =>
  post.mockRejectedValueOnce({ response: { status, data: { code, message: RAW } } });

const openSheet = async () => {
  renderWithProviders(<CounterTodaysSales />);
  fireEvent.click(screen.getByRole("button", { name: "Today's sales" }));
  await screen.findByText("ORD-1");
};
const rowVoidButton = () => screen.getByRole("button", { name: "Void sale ORD-1" });
const confirmVoid = () => screen.getByRole("button", { name: "Void sale" });
const typeReason = (text: string) =>
  fireEvent.change(screen.getByLabelText("Reason for voiding"), { target: { value: text } });

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  serve(() => [row()]);
});

describe("Void sale: who sees the button", () => {
  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])("%s sees it on a live row", async (r) => {
    role = r;
    await openSheet();
    expect(rowVoidButton()).toBeInTheDocument();
  });

  it.each([["DRIVER"], ["CUSTOMER"], [undefined]])("%s does not", async (r) => {
    role = r;
    await openSheet();
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });

  it("a sale with a return has none (the server would refuse COUNTER_SALE_VOID_HAS_RETURN)", async () => {
    serve(() => [row({ returned: { amount: 5, state: "PARTLY", returns: [] } })]);
    await openSheet();
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });

  it("a voided row has none", async () => {
    serve(() => [row({ voided: true })]);
    await openSheet();
    expect(screen.getByText("Voided")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });
});

describe("Void sale: the dialog", () => {
  it("requires a reason: empty and 2-character reasons never leave", async () => {
    await openSheet();
    fireEvent.click(rowVoidButton());
    fireEvent.click(confirmVoid());
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a reason of at least 3");
    typeReason("  a  ");
    fireEvent.click(confirmVoid());
    expect(post).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason to the void route, shows the server's hand-back and marks the row Voided", async () => {
    let voided = false;
    serve(() => [row({ voided })]);
    post.mockImplementationOnce(() => {
      voided = true;
      return Promise.resolve({
        data: { voided: true, handBack: { CASH: 12.5, CARD: 10 } },
      });
    });
    await openSheet();
    fireEvent.click(rowVoidButton());
    typeReason("  wrong item rung  ");
    fireEvent.click(confirmVoid());

    const done = await screen.findByTestId("counter-void-done");
    expect(post).toHaveBeenCalledWith("/orders/counter-sale/o1/void", {
      reason: "wrong item rung",
    });
    expect(within(done).getByTestId("counter-void-handback")).toHaveTextContent(
      "Give back $12.50 cash · Void the card payment on the card terminal",
    );
    fireEvent.click(within(screen.getByRole("dialog", { name: /Void sale/ })).getByText("Done"));
    await waitFor(() => expect(screen.getByText("Voided")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });

  it("a card-only sale says only to void the card payment; no cash line", async () => {
    post.mockResolvedValueOnce({ data: { voided: true, handBack: { CARD: 22.5 } } });
    await openSheet();
    fireEvent.click(rowVoidButton());
    typeReason("customer left");
    fireEvent.click(confirmVoid());
    expect(await screen.findByTestId("counter-void-handback")).toHaveTextContent(
      /^Void the card payment on the card terminal$/,
    );
  });

  it("a repeat (200 replayed) shows the same hand-back and says it was already voided", async () => {
    post.mockResolvedValueOnce({
      data: { voided: true, replayed: true, handBack: { CASH: 22.5 } },
    });
    await openSheet();
    fireEvent.click(rowVoidButton());
    typeReason("double tap");
    fireEvent.click(confirmVoid());
    const done = await screen.findByTestId("counter-void-done");
    expect(done).toHaveTextContent("This sale was already voided.");
    expect(done).toHaveTextContent("Give back $22.50 cash");
  });

  it("a 409 COUNTER_SALE_VOIDED (dead already) is a done state, not an error, and the list refetches", async () => {
    reject(409, "COUNTER_SALE_VOIDED");
    await openSheet();
    const before = get.mock.calls.length;
    fireEvent.click(rowVoidButton());
    typeReason("office cancelled it");
    fireEvent.click(confirmVoid());
    const done = await screen.findByTestId("counter-void-done");
    expect(done).toHaveTextContent(COUNTER_VOID_ERROR_COPY.COUNTER_SALE_VOIDED);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
    expect(document.body.textContent).not.toContain(RAW);
  });

  const REFUSALS = COUNTER_VOID_ERROR_CODES.filter((c) => c !== "COUNTER_SALE_VOIDED");
  it.each(REFUSALS)(
    "%s shows its fixed copy, never the server text, and stays open",
    async (code) => {
      reject(
        code === "COUNTER_SALE_VOID_BUSY" ? 503 : code === "COUNTER_SALE_NOT_FOUND" ? 404 : 409,
        code,
      );
      await openSheet();
      fireEvent.click(rowVoidButton());
      typeReason("because");
      fireEvent.click(confirmVoid());
      const err = await screen.findByTestId("counter-void-error");
      expect(err).toHaveTextContent(
        COUNTER_VOID_ERROR_COPY[code as keyof typeof COUNTER_VOID_ERROR_COPY],
      );
      expect(document.body.textContent).not.toContain(RAW);
      expect(screen.queryByTestId("counter-void-done")).toBeNull();
      expect(confirmVoid()).toBeEnabled();
    },
  );

  it("409 COUNTER_SALE_DAY_CLOSED: the closed-day sentence that points at Return, not the generic conflict line", async () => {
    reject(409, "COUNTER_SALE_DAY_CLOSED");
    await openSheet();
    fireEvent.click(rowVoidButton());
    typeReason("because");
    fireEvent.click(confirmVoid());
    const err = await screen.findByTestId("counter-void-error");
    expect(err).toHaveTextContent("This sale is in a closed day. Use Return items instead.");
    expect(document.body.textContent).not.toMatch(/conflicts with something/i);
    expect(document.body.textContent).not.toContain(RAW);
    expect(screen.queryByTestId("counter-void-done")).toBeNull();
    expect(confirmVoid()).toBeEnabled();
  });

  it("a 400 validation and an unknown 500 get the app's generic fixed copy, never the server text", async () => {
    reject(400);
    await openSheet();
    fireEvent.click(rowVoidButton());
    typeReason("because");
    fireEvent.click(confirmVoid());
    expect(await screen.findByTestId("counter-void-error")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(RAW);
    reject(500, "SOMETHING_NEW");
    fireEvent.click(confirmVoid());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("counter-void-error")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(RAW);
  });

  it("Keep sale closes without a request", async () => {
    await openSheet();
    fireEvent.click(rowVoidButton());
    fireEvent.click(screen.getByRole("button", { name: "Keep sale" }));
    await waitFor(() => expect(screen.queryByLabelText("Reason for voiding")).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });
});
