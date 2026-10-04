import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { LineItemRow, type LineItemRowItem, type LineItemRowProps } from "./LineItemRow";
import { PriceHistoryButton } from "./PriceHistory";
import type { PriceHistoryResponse, PriceHistoryRow } from "@/lib/api/price-history";

/**
 * Customer price-history popover (plan step 2B). Hits the real hook through a mocked apiClient so
 * the request shape (GET /customers/:c/products/:p/price-history?limit=25) is pinned too.
 */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-20T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 12.9,
  unitLabel: "case",
  unitsPerBox: 24,
  qty: 2,
  boxes: 2,
  pieces: 0,
  avgCostAtSale: 8.4,
  invoiceId: "inv-1",
  invoiceNumber: "INV-0001",
  orderId: "ord-1",
  orderNumber: "ORD-0001",
  priceType: null,
  ...over,
});

const response = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "cust-1",
  customerName: "Acme Foods",
  productId: "prod-1",
  productName: "Sample Cola 24pk",
  costVisible: true,
  rows: [
    row(),
    row({
      date: "2026-09-27T00:00:00.000Z",
      unitPrice: 13.5,
      invoiceNumber: "INV-0002",
      orderNumber: "ORD-0002",
      priceType: "DISCOUNTED",
      avgCostAtSale: 8.6,
    }),
    row({
      date: "2026-10-01T00:00:00.000Z",
      source: "OPEN_ORDER",
      unitPrice: 14,
      invoiceId: null,
      invoiceNumber: null,
      orderNumber: "ORD-0003",
      avgCostAtSale: null,
    }),
    row({ unitLabel: "piece", unitPrice: 0.65, qty: 12, unitsPerBox: null, avgCostAtSale: 0.35 }),
  ],
  summaries: [
    { unitLabel: "case", last: 14, low: 12.9, high: 14, qtySold: 6, currentAvgCost: 8.7 },
    { unitLabel: "piece", last: 0.65, low: 0.65, high: 0.65, qtySold: 12, currentAvgCost: 0.36 },
  ],
  ...over,
});

const onUsePrice = jest.fn();

function renderButton(props: Partial<React.ComponentProps<typeof PriceHistoryButton>> = {}) {
  return renderWithProviders(
    <div>
      <input aria-label="price input" defaultValue="12.90" />
      <PriceHistoryButton
        customerId="cust-1"
        customerName="Acme Foods"
        productId="prod-1"
        productName="Sample Cola 24pk"
        unitHint="case"
        onUsePrice={onUsePrice}
        {...props}
      />
    </div>,
  );
}

const openPanel = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Price history" }));
  return user;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: response() });
});

describe("PriceHistoryButton — availability", () => {
  it("is disabled with a tooltip until a customer AND a product are chosen", () => {
    const { unmount } = renderButton({ customerId: null });
    const btn = screen.getByRole("button", { name: "Price history" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Choose a customer and a product first");
    unmount();
    renderButton({ productId: "" });
    expect(screen.getByRole("button", { name: "Price history" })).toBeDisabled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("is enabled once both exist and requests the documented endpoint", async () => {
    renderButton();
    expect(screen.getByRole("button", { name: "Price history" })).toBeEnabled();
    await openPanel();
    await screen.findByText(/Price history · Sample Cola 24pk/);
    expect(mockGet).toHaveBeenCalledWith("/customers/cust-1/products/prod-1/price-history", {
      params: { limit: 25 },
    });
  });
});

describe("PriceHistoryButton — popover behaviour", () => {
  it("opens and closes (Esc, outside click, toggle) without changing the price, returning focus to the input", async () => {
    const outer = jest.fn();
    document.addEventListener("keydown", outer);
    renderButton();
    const input = screen.getByLabelText("price input") as HTMLInputElement;

    const user = await openPanel();
    await screen.findByRole("dialog", { name: "Price history" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.value).toBe("12.90");
    // Escape was stopped in the capture phase: a surrounding dialog's listener never saw it.
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);

    await user.click(screen.getByRole("button", { name: "Price history" }));
    await screen.findByRole("dialog", { name: "Price history" });
    await user.click(document.body);
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Price history" }));
    await screen.findByRole("dialog", { name: "Price history" });
    await user.click(screen.getByRole("button", { name: "Price history" }));
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();

    expect(onUsePrice).not.toHaveBeenCalled();
    expect(input.value).toBe("12.90");
  });

  it("\"Use this price\" hands that row's price to the line's price path and closes", async () => {
    renderButton();
    const user = await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await user.click(within(dialog).getByRole("button", { name: "Use this price $13.50" }));
    expect(onUsePrice).toHaveBeenCalledTimes(1);
    expect(onUsePrice).toHaveBeenCalledWith(13.5);
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
  });

  it("shows header, customer, stats and tags open orders as not invoiced yet", async () => {
    renderButton();
    await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(within(dialog).getByText("Price history · Sample Cola 24pk")).toBeInTheDocument();
    expect(within(dialog).getByText("Customer: Acme Foods")).toBeInTheDocument();
    for (const label of ["Last", "Low", "High", "Qty sold"])
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    expect(within(dialog).getByText("$12.90", { selector: "div" })).toBeInTheDocument(); // low
    expect(within(dialog).getByText("not invoiced yet")).toBeInTheDocument();
    expect(within(dialog).getByText("INV-0002")).toBeInTheDocument();
    expect(within(dialog).getByText("Discount")).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: /Price trend/ })).toBeInTheDocument();
  });
});

describe("PriceHistoryButton — cost visibility", () => {
  it("costVisible=false: no cost column, stat, toggle or value anywhere", async () => {
    mockGet.mockResolvedValue({
      data: response({
        costVisible: false,
        rows: response().rows.map((r) => ({ ...r, avgCostAtSale: null })),
        summaries: response().summaries.map((s) => ({ ...s, currentAvgCost: null })),
      }),
    });
    renderButton();
    await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("Qty sold");
    expect(within(dialog).queryByText("Avg cost")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Avg cost now")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /show cost/i })).not.toBeInTheDocument();
    expect(dialog.textContent).not.toContain("••••");
    expect(dialog.textContent).not.toMatch(/8\.[0-9]{2}/);
  });

  it("costVisible=true: masked until Show cost, hidden again by Hide cost", async () => {
    renderButton();
    const user = await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await within(dialog).findByText("Avg cost");
    expect(dialog.textContent).toContain("••••");
    expect(dialog.textContent).not.toContain("$8.40");
    expect(dialog.textContent).not.toContain("$8.70");

    await user.click(within(dialog).getByRole("button", { name: /show cost/i }));
    expect(dialog.textContent).toContain("$8.40");
    expect(dialog.textContent).toContain("$8.70");
    expect(dialog.textContent).not.toContain("••••".repeat(2)); // no masked cell with a value left

    await user.click(within(dialog).getByRole("button", { name: /hide cost/i }));
    expect(dialog.textContent).not.toContain("$8.40");
    expect(dialog.textContent).toContain("••••");
  });
});

describe("PriceHistoryButton — states", () => {
  it("shows a loading skeleton while the request is in flight", async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    renderButton();
    await openPanel();
    expect(
      await screen.findByRole("status", { name: "Loading price history" }),
    ).toBeInTheDocument();
  });

  it("an error shows fixed copy and Retry, never the server text or $0, and Retry refetches", async () => {
    mockGet.mockRejectedValueOnce(
      Object.assign(new Error('boom: relation "InvoiceItem" does not exist'), {
        response: { data: { message: "SQL exploded at /srv/api" } },
      }),
    );
    renderButton();
    const user = await openPanel();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load price history.");
    expect(alert.textContent).not.toMatch(/boom|SQL|InvoiceItem|\$0/);
    mockGet.mockResolvedValueOnce({ data: response() });
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Customer: Acme Foods");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("no past sales shows the empty copy", async () => {
    mockGet.mockResolvedValue({ data: response({ rows: [], summaries: [] }) });
    renderButton();
    await openPanel();
    expect(
      await screen.findByText("No past sales of this product to this customer"),
    ).toBeInTheDocument();
  });
});

describe("PriceHistoryButton — units are never mixed", () => {
  it("defaults to the line's unit and a unit switch swaps the whole table, stats and Use", async () => {
    renderButton({ unitHint: "case" });
    const user = await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["case", "piece"]);
    expect(within(dialog).getByRole("tab", { name: "case" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // case view: three case rows, no piece price
    expect(within(dialog).getByText("INV-0002")).toBeInTheDocument();
    expect(within(dialog).queryByText("$0.65")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("tab", { name: "piece" }));
    expect(within(dialog).queryByText("INV-0002")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("$0.65").length).toBeGreaterThan(0);
    // a piece price may not be applied to a line entered by the case
    expect(within(dialog).getByRole("button", { name: "Use this price $0.65" })).toBeDisabled();
  });

  it("opens on the piece unit when the line is entered by the piece", async () => {
    renderButton({ unitHint: "piece" });
    await openPanel();
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await waitFor(() =>
      expect(within(dialog).getByRole("tab", { name: "piece" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "Use this price $0.65" })).toBeEnabled();
  });
});

describe("LineItemRow wiring", () => {
  const item: LineItemRowItem = {
    tempId: "t1",
    productId: "prod-1",
    productName: "Sample Cola 24pk",
    unit: "case",
    listPrice: 12.9,
    unitPrice: 12.9,
    priceType: "STANDARD",
    qty: 24,
    unitsPerBox: 24,
    boxes: 1,
    pieces: 0,
    sellBy: "case",
  };
  const baseProps = (over: Partial<LineItemRowProps> = {}): LineItemRowProps => ({
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
    ...over,
  });
  const renderRow = (props: LineItemRowProps) =>
    renderWithProviders(
      <ul>
        <LineItemRow {...props} />
      </ul>,
    );

  it("a row with no customerPriceHistory prop (vendor bills, read-only, scan) has no button", () => {
    renderRow(baseProps());
    expect(screen.queryByRole("button", { name: "Price history" })).not.toBeInTheDocument();
  });

  it("shows a button beside the price input, disabled until a customer is chosen; Use sets the price via the row's callback", async () => {
    const pick = jest.fn();
    const { unmount } = renderRow(
      baseProps({ customerPriceHistory: { customerId: null, onUsePrice: pick } }),
    );
    expect(screen.getByRole("button", { name: "Price history" })).toBeDisabled();
    unmount();

    renderRow(
      baseProps({
        priceHistoryEntry: { lastPrice: 13.5 },
        customerPriceHistory: {
          customerId: "cust-1",
          customerName: "Acme Foods",
          onUsePrice: pick,
        },
      }),
    );
    // the auto last-price text is untouched
    expect(screen.getByText("Last: $13.50")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await user.click(within(dialog).getByRole("button", { name: "Use this price $13.50" }));
    expect(pick).toHaveBeenCalledWith(13.5);
  });

  it("a SPECIAL line (no price input) still gets the history button", () => {
    renderRow(
      baseProps({
        item: { ...item, priceType: "SPECIAL", specialPrice: 12.9 },
        customerPriceHistory: { customerId: "cust-1", onUsePrice: jest.fn() },
      }),
    );
    expect(screen.getByRole("button", { name: "Price history" })).toBeEnabled();
  });
});
