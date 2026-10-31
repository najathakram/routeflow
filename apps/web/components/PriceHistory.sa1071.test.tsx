import * as React from "react";
import { renderWithProviders, screen, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type { PriceHistoryResponse, PriceHistoryRow } from "@/lib/api/price-history";

/**
 * SA-1071 P3: one pill per row, at most. "not invoiced yet" describes where the number came from, not the price, so it is
 * plain muted text beside the number; the price-type pill (Special, Discount, Override) stays the row's one pill.
 */
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

const open = async (rows: PriceHistoryRow[]) => {
  const data: PriceHistoryResponse = {
    customerId: "c1",
    customerName: "Acme Foods",
    productId: "p1",
    productName: "Cola",
    costVisible: false,
    rows,
    summaries: [
      { unitLabel: "case", last: 10, low: 10, high: 10, qtySold: 2, currentAvgCost: null },
    ],
    references: { listPrice: 14, tierPrice: 12.5, changeSinceLast: null },
  };
  mockGet.mockResolvedValue({ data });
  renderWithProviders(
    <PriceHistoryButton
      customerId="c1"
      customerName="Acme Foods"
      productId="p1"
      productName="Cola"
      unitHint="case"
      onUsePrice={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Price history" }));
  return screen.findByRole("dialog", { name: "Price history" });
};

/** the visual weight a chip carries: a rounded box, a fill or a ring */
const isPill = (el: HTMLElement) => /(^|\s)(rounded\S*|bg-\S+|ring-\S+)(\s|$)/.test(el.className);

beforeEach(() => jest.clearAllMocks());

describe("SA-1071 P3: not invoiced yet is plain text, the price-type pill stays", () => {
  const pending = row({
    source: "OPEN_ORDER",
    invoiceId: null,
    invoiceNumber: null,
    orderNumber: "ORD-2",
    priceType: "SPECIAL",
  });

  it("P3: the source label is not a pill", async () => {
    const dialog = await open([pending]);
    const label = await within(dialog).findByText("not invoiced yet");
    expect(isPill(label)).toBe(false);
  });

  it("P3: a row that is both not invoiced and special shows exactly one pill, the price type", async () => {
    const dialog = await open([pending]);
    const row0 = (await within(dialog).findByText("not invoiced yet")).closest("tr") as HTMLElement;
    const pills = Array.from(row0.querySelectorAll<HTMLElement>("span")).filter(isPill);
    expect(pills.map((p) => p.textContent)).toEqual(["Special"]);
  });

  it("P3: an invoiced Discount row keeps its one pill", async () => {
    const dialog = await open([row({ priceType: "DISCOUNTED" })]);
    const tag = await within(dialog).findByText("Discount");
    expect(isPill(tag)).toBe(true);
  });
});
