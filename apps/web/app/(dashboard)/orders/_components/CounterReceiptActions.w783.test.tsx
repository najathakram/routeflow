import * as React from "react";
import type { SubscriptionView, TodaysSaleRow } from "@routeflow/types";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptActions } from "./CounterReceiptActions";
import { CounterReceiptView } from "./CounterReceiptView";

/**
 * W-715 / W-716 / F13: the receipt's Change row is a normal row on an exact sale, its actions sit in one row from sm up and a
 * 2×2 grid (New sale full width under it) at phone width with nothing hidden, and "Void sale" opens the existing void dialog
 * for THIS sale. The API is mocked at the
 * apiClient boundary; the role gate is the real staffMay(role, "VOID_SALE").
 */
const post = jest.fn();
const get = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
let role: string | undefined = "OPERATOR";
let orderStatus = "DELIVERED";
let addon = false;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => addon }));
let recorded: ((r?: unknown, info?: unknown) => void) | undefined;
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: Record<string, unknown>) => {
    recorded = p.onRecorded as typeof recorded;
    return null;
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username: "pat" } : null }),
}));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({
    data: {
      id: "o1",
      orderNumber: "ORD-00001",
      customerId: "c1",
      total: 25,
      status: orderStatus,
      lineItems: [{ id: "l1", name: "Cola", product: { name: "Cola 12oz" }, qty: 10 }],
    },
  }),
}));

const model = (change: number | null, cashTendered = 25) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-00001",
      invoiceId: "i1",
      invoiceNumber: "INV-00001",
      total: 25,
      paid: 25,
      balanceDue: 0,
      paymentRecorded: true,
      method: "CASH",
      cashTendered,
      ...(change == null ? {} : { change }),
    },
    lines: [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 10 }],
    enteredTender: null,
    profile: null,
    now: new Date("2026-10-07T15:15:00.000Z"),
  });

describe("W-715: Change is not a second headline on an exact sale", () => {
  it("a $0.00 change is a normal row, not text-lg", () => {
    renderWithProviders(<CounterReceiptView model={model(0)} />);
    const row = screen.getByTestId("receipt-change");
    expect(row).toHaveTextContent("$0.00");
    expect(row.className).not.toContain("text-lg");
    expect(row.className).not.toContain("font-semibold");
  });
  it("real change keeps its emphasis", () => {
    renderWithProviders(<CounterReceiptView model={model(5, 30)} />);
    const row = screen.getByTestId("receipt-change");
    expect(row).toHaveTextContent("$5.00");
    expect(row.className).toContain("text-lg");
  });
});

/** Today's-sales row for the sale (the receipt reads how it was paid, voided and returned from it). */
const saleRow = (over: Partial<TodaysSaleRow> = {}) =>
  ({
    orderId: "o1",
    orderNumber: "ORD-00001",
    methods: [{ method: "CASH", amount: 25 }],
    returned: { amount: 0, state: "NONE", returns: [] },
    voided: false,
    ...over,
  }) as unknown as TodaysSaleRow;
const serveToday = (rows: TodaysSaleRow[]) =>
  get.mockImplementation((url: string) =>
    url === "/orders/counter-sale/today"
      ? Promise.resolve({
          data: {
            data: rows,
            meta: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
            summary: null,
          },
        })
      : Promise.resolve({ data: {} }),
  );

const renderActions = (props: Partial<React.ComponentProps<typeof CounterReceiptActions>> = {}) =>
  renderWithProviders(
    <CounterReceiptActions orderId="o1" customer={null} onNewSale={jest.fn()} {...props} />,
  );

describe("W-715 + P-RCPT-1: one row from sm up, a 2×2 grid at phone width", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    role = "OPERATOR";
    orderStatus = "DELIVERED";
    addon = false;
    serveToday([saleRow()]);
  });
  it("every action is visible in DOM (= Tab) order, as a 2-column grid below sm with New sale full width", async () => {
    renderActions();
    await screen.findByRole("button", { name: "Void sale ORD-00001" });
    const main = screen.getByTestId("receipt-actions-main");
    const names = Array.from(main.querySelectorAll("button")).map((b) => b.textContent);
    expect(names).toEqual(["Print", "Email receipt", "Void sale", "New sale"]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull(); // nothing hidden behind a menu
    expect(main.className).toMatch(/(^|\s)grid-cols-2(\s|$)/);
    expect(main.className).toMatch(/sm:flex/);
    expect(screen.getByRole("button", { name: "New sale" }).className).toMatch(/col-span-2/);
  });
});

describe("W-716 / F13: Void sale on the receipt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    role = "OPERATOR";
    orderStatus = "DELIVERED";
    addon = false;
    serveToday([saleRow()]);
  });
  it("opens the void dialog with this sale's total, methods and items", async () => {
    serveToday([
      saleRow({
        methods: [
          { method: "CASH", amount: 10 },
          { method: "CARD", amount: 15 },
        ],
      }),
    ]);
    renderActions(); // no methodsText: the method comes from the sale's own data
    fireEvent.click(await screen.findByRole("button", { name: "Void sale ORD-00001" }));
    expect(screen.getByText("Void sale ORD-00001 · $25.00")).toBeInTheDocument();
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("Cash + Card");
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("Cola 12oz");
  });
  it("a sale with nothing paid reads On account, and a passed methodsText still wins", async () => {
    serveToday([saleRow({ methods: [] })]);
    const { unmount } = renderActions();
    fireEvent.click(await screen.findByRole("button", { name: "Void sale ORD-00001" }));
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("On account");
    unmount();
    renderActions({ methodsText: "Store credit" });
    fireEvent.click(await screen.findByRole("button", { name: "Void sale ORD-00001" }));
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("Store credit");
  });
  it("a voided order read back (remount) shows Voided, not Void sale", async () => {
    orderStatus = "CANCELLED";
    renderActions();
    expect(await screen.findByRole("button", { name: "Voided" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Void sale/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
  });
  it("a voided row read back shows Voided", async () => {
    serveToday([saleRow({ voided: true })]);
    renderActions();
    expect(await screen.findByRole("button", { name: "Voided" })).toBeDisabled();
  });
  it("a sale with a return recorded against it offers no Void sale (Today's sales rule)", async () => {
    serveToday([
      saleRow({
        returned: { amount: 5, state: "PARTLY", returns: [] },
      }),
    ]);
    renderActions();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await screen.findByRole("button", { name: "New sale" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull());
  });
  it("read-only: Void sale points at the receipt's own hint, not Today's sales' id", async () => {
    const readOnly = {
      status: "READ_ONLY",
      billingContactName: "Dana",
    } as unknown as SubscriptionView;
    renderWithProviders(
      <ReadOnlyGateProvider view={readOnly}>
        <CounterReceiptActions orderId="o1" customer={null} onNewSale={jest.fn()} />
      </ReadOnlyGateProvider>,
    );
    const btn = await screen.findByRole("button", { name: "Void sale ORD-00001" });
    const hint = screen.getByTestId("read-only-line");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-describedby", hint.id);
  });
  it("after a void, Return items is gone (a voided sale cannot be returned); Email receipt stays", async () => {
    addon = true;
    post.mockResolvedValueOnce({ data: { handBack: { CASH: 25 }, replayed: false } });
    renderActions();
    expect(await screen.findByRole("button", { name: "Return items" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Void sale ORD-00001" }));
    fireEvent.change(screen.getByLabelText(/Reason for voiding/), {
      target: { value: "Rang up twice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Void sale" }));
    await screen.findByTestId("counter-void-done");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByTestId("receipt-voided")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
    expect(screen.getByRole("button", { name: "Email receipt" })).toBeInTheDocument();
  });
  it("after a return is recorded here, Void sale goes away", async () => {
    addon = true;
    renderActions();
    expect(await screen.findByRole("button", { name: "Void sale ORD-00001" })).toBeInTheDocument();
    React.act(() => recorded?.({}, { resolution: "STORE_CREDIT", amount: 5 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Void sale/ })).toBeNull());
  });
  it("is absent for a role that may not void", () => {
    role = "DRIVER";
    renderActions();
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });
  it("after a void the receipt says so and the control reads Voided", async () => {
    post.mockResolvedValueOnce({ data: { handBack: { CASH: 25 }, replayed: false } });
    renderActions();
    fireEvent.click(await screen.findByRole("button", { name: "Void sale ORD-00001" }));
    fireEvent.change(screen.getByLabelText(/Reason for voiding/), {
      target: { value: "Rang up twice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Void sale" }));
    await screen.findByTestId("counter-void-done");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByTestId("receipt-voided")).toHaveTextContent("voided"));
    expect(screen.getByRole("button", { name: "Voided" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New sale" })).toBeInTheDocument();
  });
});
