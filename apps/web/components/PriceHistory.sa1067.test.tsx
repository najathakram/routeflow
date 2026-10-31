import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type {
  PriceHistoryResponse,
  PriceHistoryRow,
  PriceSummaryEntry,
} from "@/lib/api/price-history";

/** SA-1067 M1 (P1-P7): the panel opens with nothing chosen; one Enter never commits a price nobody picked. */

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
  salePack: over.unitsPerBox !== undefined ? (over.unitsPerBox ?? 1) : 24,
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

const summaries: PriceSummaryEntry[] = [
  { unitLabel: "case", last: 13, low: 10, high: 13, qtySold: 8, currentAvgCost: 6.5 },
];

const base = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: true,
  rows: [
    row({ date: "2026-09-01T00:00:00.000Z", unitPrice: 10, orderId: "a", invoiceNumber: "INV-A" }),
    row({ date: "2026-09-10T00:00:00.000Z", unitPrice: 11, orderId: "b", invoiceNumber: "INV-B" }),
    row({ date: "2026-09-20T00:00:00.000Z", unitPrice: 12, orderId: "c", invoiceNumber: "INV-C" }),
    row({ date: "2026-09-25T00:00:00.000Z", unitPrice: 13, orderId: "d", invoiceNumber: "INV-D" }),
  ],
  summaries,
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

const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  renderBtn();
  screen.getByLabelText("price input").focus();
  await user.keyboard("{Alt>}h{/Alt}");
  const dialog = await screen.findByRole("dialog", { name: "Price history" });
  await within(dialog).findByText("INV-B"); // base(): newest first 13, 12, 11, 10
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return dialog;
};
const bodyRows = (dialog: HTMLElement) => within(dialog).getAllByRole("row").slice(1);

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: base() });
});

describe("SA-1067 M1: the history panel opens with no row chosen", () => {
  it("P1/P2: a scanner's one Enter (digits then Enter) on the open panel commits nothing and keeps it open", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    await user.keyboard("123456789012{Enter}");
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Price history" })).toBe(dialog);
  });

  it("opens with no row highlighted or selected", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    const rows = bodyRows(dialog);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toHaveAttribute("aria-selected", "false");
  });

  it("P3: a pointer resting on a row does not choose it; Enter commits nothing", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    const rows = bodyRows(dialog);
    await user.hover(rows[2]);
    expect(rows[2]).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Enter}");
    expect(onUse).not.toHaveBeenCalled();
  });

  it("P4: the first ArrowDown lands on the newest row, so Down then Enter uses row 0 (13)", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    await user.keyboard("{ArrowDown}");
    expect(bodyRows(dialog)[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(13);
  });

  it("ArrowUp from nothing chosen lands on the newest row as well", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    await user.keyboard("{ArrowUp}");
    expect(bodyRows(dialog)[0]).toHaveAttribute("aria-selected", "true");
  });

  it("P5: changing the unit tab clears the highlight, so a later Enter commits nothing", async () => {
    mockGet.mockResolvedValue({
      data: base({
        rows: [
          row({
            date: "2026-09-01T00:00:00.000Z",
            unitPrice: 10,
            orderId: "a",
            invoiceNumber: "INV-A",
          }),
          row({
            date: "2026-09-02T00:00:00.000Z",
            unitPrice: 11,
            orderId: "b",
            invoiceNumber: "INV-B",
          }),
          row({
            date: "2026-09-03T00:00:00.000Z",
            unitPrice: 2,
            unitLabel: "piece",
            orderId: "c",
            invoiceNumber: "INV-C",
          }),
          row({
            date: "2026-09-04T00:00:00.000Z",
            unitPrice: 3,
            unitLabel: "piece",
            orderId: "d",
            invoiceNumber: "INV-D",
          }),
        ],
        summaries: [],
      }),
    });
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.click(within(dialog).getByRole("tab", { name: "piece" }));
    for (const r of bodyRows(dialog)) expect(r).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(within(dialog).getByRole("table"), { key: "Enter" });
    expect(onUse).not.toHaveBeenCalled();
  });

  it.each([["{Enter}"], [" "]])(
    "P6: Tab to a Use button, then %j, still uses that row's price",
    async (key) => {
      const user = userEvent.setup();
      renderBtn();
      screen.getByLabelText("price input").focus();
      await user.keyboard("{Alt>}h{/Alt}");
      const dialog = await screen.findByRole("dialog", { name: "Price history" });
      const use = await within(dialog).findByRole("button", { name: "Use this price ($12.00)" });
      use.focus();
      await user.keyboard(key);
      expect(onUse).toHaveBeenCalledWith(12);
    },
  );

  it("P7: Esc closes and focus goes to the trigger", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Price history" })).toHaveFocus(),
    );
    expect(onUse).not.toHaveBeenCalled();
  });
});
