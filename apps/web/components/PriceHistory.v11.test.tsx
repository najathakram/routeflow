import * as React from "react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, within, fireEvent } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";
import { PriceChips, PriceHistoryButton } from "./PriceHistory";
import type {
  PriceHistoryResponse,
  PriceHistoryRow,
  PriceSummaryEntry,
} from "@/lib/api/price-history";

/** v1.1: prefetch, placement, keyboard, chips, references, compare, margin, chart markers. */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-20T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 10,
  unitLabel: "case",
  unitsPerBox: 24,
  qty: 2,
  boxes: 2,
  pieces: 0,
  avgCostAtSale: 6,
  invoiceId: "inv-1",
  invoiceNumber: "INV-1",
  orderId: "o-1",
  orderNumber: "ORD-1",
  priceType: null,
  ...over,
});

const base = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: true,
  rows: [
    row({ date: "2026-09-01T00:00:00.000Z", unitPrice: 10, orderId: "a", invoiceNumber: "INV-A" }),
    row({
      date: "2026-09-10T00:00:00.000Z",
      unitPrice: 11,
      priceType: "SPECIAL",
      orderId: "b",
      invoiceNumber: "INV-B",
    }),
    row({
      date: "2026-09-20T00:00:00.000Z",
      unitPrice: 12,
      priceType: "DISCOUNTED",
      orderId: "c",
      invoiceNumber: "INV-C",
    }),
    row({ date: "2026-09-25T00:00:00.000Z", unitPrice: 13, orderId: "d", invoiceNumber: "INV-D" }),
  ],
  summaries: [{ unitLabel: "case", last: 13, low: 10, high: 13, qtySold: 8, currentAvgCost: 6.5 }],
  references: { listPrice: 14, tierPrice: 12.5, changeSinceLast: 0.03 },
  aggregate: { low: 9, median: 11.5, high: 15, customers: 7, unitLabel: "case" },
  ...over,
});

const onUse = jest.fn();
const renderBtn = () =>
  renderWithProviders(
    <div>
      <input aria-label="price input" />
      <PriceHistoryButton
        customerId="c1"
        customerName="Acme Foods"
        productId="p1"
        productName="Cola"
        unitHint="case"
        onUsePrice={onUse}
      />
    </div>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: base() });
});

describe("prefetch", () => {
  it("fetches as soon as customer + product are known; opening shows no spinner and no second request", async () => {
    // the shared test client has gcTime 0, which would drop an unobserved prefetch at once
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(
      <PriceHistoryButton
        customerId="c1"
        customerName="Acme Foods"
        productId="p1"
        productName="Cola"
        unitHint="case"
        onUsePrice={onUse}
      />,
      { queryClient },
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Customer: Acme Foods")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("does not fetch while the customer is missing", () => {
    renderWithProviders(
      <PriceHistoryButton productId="p1" productName="Cola" onUsePrice={onUse} />,
    );
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("keyboard", () => {
  it("Alt+H from the price field opens, arrows move, Enter uses the active row, focus returns", async () => {
    const user = userEvent.setup();
    renderBtn();
    const input = screen.getByLabelText("price input");
    expect(screen.getByRole("button", { name: "Price history" })).toHaveAttribute(
      "title",
      "Price history (Alt+H)",
    );
    input.focus();
    await user.keyboard("{Alt>}h{/Alt}");
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("INV-D"); // newest first: 13, 12, 11, 10
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onUse).toHaveBeenCalledWith(11);
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("Esc closes and returns focus to the trigger (not the price field)", async () => {
    const user = userEvent.setup();
    renderBtn();
    const input = screen.getByLabelText("price input");
    input.focus();
    await user.keyboard("{Alt>}h{/Alt}");
    await screen.findByRole("dialog", { name: "Price history" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Price history" })).toHaveFocus(),
    );
    expect(input).not.toHaveFocus();
    expect(onUse).not.toHaveBeenCalled();
  });
});

describe("placement", () => {
  it("flips above the anchor near the viewport bottom and stays inside the viewport", async () => {
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    const rect = { top: 560, bottom: 580, left: 20, right: 40, width: 20, height: 20 } as DOMRect;
    const spy = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const off = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await waitFor(() => expect(dialog.style.visibility).toBe("visible"));
    const top = parseFloat(dialog.style.top);
    expect(top).toBeLessThan(560);
    expect(top).toBeGreaterThanOrEqual(8);
    spy.mockRestore();
    off.mockRestore();
  });
});

describe("references, compare, margin, markers", () => {
  it("S1: a FAILED comparison keeps this customer's rows and shows the error inline on the toggle", async () => {
    mockGet.mockImplementation((_url: string, cfg?: { params?: { compare?: string } }) =>
      cfg?.params?.compare === "all"
        ? Promise.reject(new Error("429"))
        : Promise.resolve({ data: base({ aggregate: undefined }) }),
    );
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("INV-D");
    fireEvent.click(await within(dialog).findByRole("button", { name: "All customers" }));
    const panel = await within(dialog).findByTestId("compare-panel");
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      /couldn.t load the comparison/i,
    );
    expect(within(dialog).getByText("INV-D")).toBeInTheDocument(); // the rows did not go away
    expect(within(dialog).queryByText(/couldn.t load price history/i)).not.toBeInTheDocument();
  });

  it("header shows list, their tier price and the change hint", async () => {
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(await within(dialog).findByText(/List \$14\.00/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Their tier price \$12\.50/)).toBeInTheDocument();
    expect(within(dialog).getByText("+3% since last order")).toBeInTheDocument();
  });

  it("Compare: the base request has no compare; choosing All customers asks the server with ?compare=all and shows low / typical / high, never names", async () => {
    const withAgg = base();
    const { aggregate: _a, ...noAgg } = withAgg;
    mockGet.mockImplementation((_url: string, cfg?: { params?: { compare?: string } }) =>
      Promise.resolve({ data: cfg?.params?.compare === "all" ? withAgg : noAgg }),
    );
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    // the toggle is offered although the base response carries no aggregate (it is the request that adds it)
    const toggle = await within(dialog).findByRole("button", { name: "All customers" });
    expect(within(dialog).queryByTestId("compare-panel")).not.toBeInTheDocument();
    expect(mockGet.mock.calls.every((c) => c[1]?.params?.compare === undefined)).toBe(true);
    fireEvent.click(toggle);
    const panel = await within(dialog).findByTestId("compare-panel");
    await waitFor(() => expect(panel).toHaveTextContent("$11.50"));
    expect(mockGet).toHaveBeenCalledWith(
      "/customers/c1/products/p1/price-history",
      expect.objectContaining({ params: expect.objectContaining({ compare: "all" }) }),
    );
    expect(panel).toHaveTextContent("$9.00");
    expect(panel).toHaveTextContent("$15.00");
    expect(panel).toHaveTextContent("7 in all");
    fireEvent.click(within(dialog).getByRole("button", { name: "This customer" }));
    expect(within(dialog).queryByTestId("compare-panel")).not.toBeInTheDocument();
  });

  it("margin % is masked until Show cost", async () => {
    const user = userEvent.setup();
    renderBtn();
    await user.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("Margin");
    expect(dialog.textContent).not.toContain("54%");
    await user.click(within(dialog).getByRole("button", { name: /show cost/i }));
    expect(dialog.textContent).toContain("54%"); // (13 - 6) / 13
  });

  it("margin column is absent when costVisible is false", async () => {
    mockGet.mockResolvedValue({
      data: base({
        costVisible: false,
        rows: base().rows.map((r) => ({ ...r, avgCostAtSale: null })),
      }),
    });
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("INV-D");
    expect(within(dialog).queryByText("Margin")).not.toBeInTheDocument();
  });

  it("chart marks special and discount sales", async () => {
    renderBtn();
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("INV-D");
    expect(within(dialog).getAllByTestId("price-marker")).toHaveLength(2);
  });
});

describe("inline last-3 chips (real onTapPrice configuration)", () => {
  const item: LineItemRowItem = {
    tempId: "t1",
    productId: "p1",
    productName: "Cola",
    unit: "case",
    listPrice: 14,
    unitPrice: 14,
    priceType: "STANDARD",
    qty: 24,
    unitsPerBox: 24,
    boxes: 1,
    pieces: 0,
    sellBy: "case",
  };
  const props = (over: Partial<LineItemRowProps> = {}): LineItemRowProps => ({
    item,
    marginFloor: 0,
    floorAcked: false,
    costRevealed: false,
    onQtyDelta: jest.fn(),
    onSetBoxes: jest.fn(),
    onSetPieces: jest.fn(),
    onSetUnitQty: jest.fn(),
    onSetSellBy: jest.fn(),
    onSetDiscountedPrice: jest.fn(),
    onSetToFloor: jest.fn(),
    onAckFloor: jest.fn(),
    onToggleCostRevealed: jest.fn(),
    onToggleNoteOpen: jest.fn(),
    onSetNote: jest.fn(),
    onUpdateUnlistedName: jest.fn(),
    onUpdateUnlistedPrice: jest.fn(),
    onRemove: jest.fn(),
    onTapPrice: jest.fn(),
    ...over,
  });
  const renderRow = (p: LineItemRowProps) =>
    renderWithProviders(
      <ul>
        <LineItemRow {...p} />
      </ul>,
    );

  const sum = (over: Partial<PriceSummaryEntry> = {}): PriceSummaryEntry => ({
    last3: [
      { date: "2026-09-25T00:00:00.000Z", unitPrice: 13, unitLabel: "case", unitsPerBox: 24 },
      { date: "2026-09-20T00:00:00.000Z", unitPrice: 12, unitLabel: "case", unitsPerBox: 24 },
      { date: "2026-09-10T00:00:00.000Z", unitPrice: 11, unitLabel: "case", unitsPerBox: 24 },
    ],
    low: 11,
    high: 13,
    unitLabel: "case",
    unitsPerBox: 24,
    ...over,
  });
  const histCalls = () =>
    mockGet.mock.calls.filter((c) => String(c[0]).includes("/price-history")).length;

  it("shows the last three prices newest first from the batch, a tap uses that price, chips make no request", async () => {
    const pick = jest.fn();
    renderRow(
      props({
        customerPriceHistory: { customerId: "c1", onUsePrice: pick, summary: { p1: sum() } },
      }),
    );
    const chips = await screen.findAllByRole("button", { name: /^Use last price/ });
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("$13.00");
    expect(chips[1]).toHaveTextContent("$12.00");
    expect(chips[2]).toHaveTextContent("$11.00");
    fireEvent.click(chips[1]!);
    expect(pick).toHaveBeenCalledWith(12);
    // only the popover button's own prefetch hits the per-product endpoint; chips add nothing
    await waitFor(() => expect(histCalls()).toBe(1));
    expect(mockGet.mock.calls.some((c) => String(c[0]).includes("/price-summary"))).toBe(false);
  });

  const renderChips = (entry: PriceSummaryEntry) =>
    renderRow(
      props({
        customerPriceHistory: { customerId: "c1", onUsePrice: jest.fn(), summary: { p1: entry } },
      }),
    );

  it("only offers prices in the line's unit and pack (a row's own pack decides)", async () => {
    renderChips(
      sum({
        last3: [
          {
            date: "2026-09-25T00:00:00.000Z",
            unitPrice: 1.5,
            unitLabel: "each",
            unitsPerBox: null,
          },
          { date: "2026-09-20T00:00:00.000Z", unitPrice: 12, unitLabel: "box", unitsPerBox: 24 },
        ],
        unitLabel: "each",
        unitsPerBox: null,
      }),
    );
    const chips = await screen.findAllByRole("button", { name: /^Use last price/ });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("$12.00");
  });

  it("Scenario A: a 12-pack row never offers its price on a 24-pack line (newest sale is a 24-pack)", async () => {
    renderChips(
      sum({
        last3: [
          { date: "2026-09-25T00:00:00.000Z", unitPrice: 24, unitLabel: "Box", unitsPerBox: 24 },
          { date: "2026-09-20T00:00:00.000Z", unitPrice: 12, unitLabel: "Box", unitsPerBox: 12 },
        ],
        unitLabel: "Box",
        unitsPerBox: 24,
      }),
    );
    const chips = await screen.findAllByRole("button", { name: /^Use last price/ });
    expect(chips.map((c) => c.textContent)).toEqual([expect.stringContaining("$24.00")]);
    expect(screen.queryByRole("button", { name: /Use last price \$12\.00/ })).toBeNull();
  });

  it("Scenario B: a 12-pack row behind a newer piece sale never offers its price on a 24-pack line", async () => {
    renderChips(
      sum({
        last3: [
          {
            date: "2026-09-25T00:00:00.000Z",
            unitPrice: 1.5,
            unitLabel: "each",
            unitsPerBox: null,
          },
          { date: "2026-09-20T00:00:00.000Z", unitPrice: 12, unitLabel: "Box", unitsPerBox: 12 },
          { date: "2026-09-10T00:00:00.000Z", unitPrice: 23, unitLabel: "Box", unitsPerBox: 24 },
        ],
        unitLabel: "each",
        unitsPerBox: null,
      }),
    );
    const chips = await screen.findAllByRole("button", { name: /^Use last price/ });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("$23.00");
    expect(screen.queryByRole("button", { name: /Use last price \$12\.00/ })).toBeNull();
  });

  it("chips themselves make no request (rendered without the popover button)", async () => {
    renderWithProviders(
      <PriceChips entry={sum()} unitHint="case" packHint={24} onUsePrice={jest.fn()} />,
    );
    expect(await screen.findAllByRole("button", { name: /^Use last price/ })).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("every line gets chips: no mount-time budget (8 lines > AUTO_FETCH_BUDGET)", async () => {
    const mk = (i: number): LineItemRowProps =>
      props({
        item: { ...item, tempId: `t${i}`, productId: `p${i}` },
        customerPriceHistory: {
          customerId: "c1",
          onUsePrice: jest.fn(),
          summary: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`p${k}`, sum()])),
        },
      });
    renderWithProviders(
      <ul>
        {Array.from({ length: 8 }, (_, i) => (
          <LineItemRow key={i} {...mk(i)} />
        ))}
      </ul>,
    );
    expect(await screen.findAllByLabelText("Recent prices")).toHaveLength(8);
  });

  it("renders no chips when the batch has no entry or no sales for the product", async () => {
    const { unmount } = renderRow(
      props({ customerPriceHistory: { customerId: "c1", onUsePrice: jest.fn(), summary: {} } }),
    );
    expect(screen.queryByLabelText("Recent prices")).not.toBeInTheDocument();
    unmount();
    renderRow(
      props({
        customerPriceHistory: {
          customerId: "c1",
          onUsePrice: jest.fn(),
          summary: {
            p1: sum({ last3: [], low: null, high: null, unitLabel: null, unitsPerBox: null }),
          },
        },
      }),
    );
    expect(screen.queryByLabelText("Recent prices")).not.toBeInTheDocument();
  });

  it("threads excludeOrderId to the popover button's history request", async () => {
    renderRow(
      props({
        customerPriceHistory: { customerId: "c1", onUsePrice: jest.fn(), excludeOrderId: "ord-9" },
      }),
    );
    await waitFor(() => expect(histCalls()).toBe(1));
    const cfg = mockGet.mock.calls.find((c) => String(c[0]).includes("/price-history"))![1];
    expect(cfg.params.excludeOrderId).toBe("ord-9");
  });
});
