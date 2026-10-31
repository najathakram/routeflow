import * as React from "react";
import { renderWithProviders, screen, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type { PriceHistoryResponse, PriceHistoryRow } from "@/lib/api/price-history";

/**
 * SA-1066 F08: the summary says LOW $11.50 but that row sat last in a long list. LOW and LAST are
 * buttons that hand the price of the matching row to the exact `onUsePrice` the row's Use hands to
 * (nothing is committed here: the line's own price step opens). No matching row, or a row the line
 * cannot use, leaves the figure as plain text.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-20T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 12.99,
  unitLabel: "case",
  unitsPerBox: 24,
  salePack: 24,
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

const manyAt1299 = Array.from({ length: 20 }, (_, i) =>
  row({
    date: new Date(Date.UTC(2026, 9, 20 - i)).toISOString(),
    orderId: `o-${i}`,
    orderNumber: `ORD-${i}`,
    invoiceNumber: `INV-${i}`,
  }),
);
const lowRow = row({
  date: "2026-04-01T00:00:00.000Z",
  unitPrice: 11.5,
  orderId: "o-low",
  orderNumber: "ORD-SEED-004",
  invoiceNumber: "INV-SEED-004",
});

const history = (
  rows: PriceHistoryRow[],
  summary: { last: number; low: number },
): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  rows,
  summaries: [
    {
      unitLabel: "case",
      last: summary.last,
      low: summary.low,
      high: 12.99,
      qtySold: 40,
      currentAvgCost: null,
    },
  ],
  references: null,
});

const open = async (data: PriceHistoryResponse, onUsePrice = jest.fn(), unitHint = "case") => {
  mockGet.mockResolvedValue({ data });
  renderWithProviders(
    <PriceHistoryButton
      customerId="c1"
      customerName="Acme Foods"
      productId="p1"
      productName="Cola"
      unitHint={unitHint}
      packHint={24}
      onUsePrice={onUsePrice}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Price history" }));
  const dialog = await screen.findByRole("dialog", { name: "Price history" });
  return { dialog, onUsePrice };
};

beforeEach(() => jest.clearAllMocks());

describe("F08: LOW and LAST in the summary use the matching row's price", () => {
  it("LOW hands $11.50 to onUsePrice and closes, with no scroll to the last row", async () => {
    const { dialog, onUsePrice } = await open(
      history([...manyAt1299, lowRow], { last: 12.99, low: 11.5 }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Use the low price ($11.50)" }),
    );
    expect(onUsePrice).toHaveBeenCalledTimes(1);
    expect(onUsePrice).toHaveBeenCalledWith(11.5);
    expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull();
  });

  it("LAST hands the newest row's price to onUsePrice", async () => {
    const { dialog, onUsePrice } = await open(
      history([...manyAt1299, lowRow], { last: 12.99, low: 11.5 }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Use the last price ($12.99)" }),
    );
    expect(onUsePrice).toHaveBeenCalledWith(12.99);
  });

  it("a figure with no matching row stays plain text", async () => {
    const { dialog } = await open(history(manyAt1299, { last: 12.99, low: 9 }));
    await within(dialog).findByText("$9.00");
    expect(within(dialog).queryByRole("button", { name: /Use the low price/ })).toBeNull();
  });

  it("a row the line cannot use (another unit) leaves its figure plain text", async () => {
    const { dialog } = await open(
      history([...manyAt1299, lowRow], { last: 12.99, low: 11.5 }),
      jest.fn(),
      "piece",
    );
    await within(dialog).findByText("$11.50", { selector: "div" });
    expect(within(dialog).queryByRole("button", { name: /Use the (low|last) price/ })).toBeNull();
  });
});
