import * as React from "react";
import { renderWithProviders, screen, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type { PriceHistoryResponse, PriceHistoryRow } from "@/lib/api/price-history";

/**
 * SA-1066 M6, F4, F5: the header change line names what it compares (the customer's last price against the one before),
 * the "not invoiced yet" chip never truncates, and Use is compact on a phone.
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

const history = (
  changeSinceLast: number | null,
  rows: PriceHistoryRow[] = [row()],
): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  rows,
  summaries: [{ unitLabel: "case", last: 10, low: 10, high: 10, qtySold: 2, currentAvgCost: null }],
  references: { listPrice: 14, tierPrice: 12.5, changeSinceLast },
});

const open = async (data: PriceHistoryResponse) => {
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

beforeEach(() => jest.clearAllMocks());

describe("price history header change line (M6)", () => {
  it("R6: exactly 0 reads Same as the order before, neutral (not amber)", async () => {
    const dialog = await open(history(0));
    const el = await within(dialog).findByText("Same as the order before");
    expect(el.className).not.toMatch(/amber|emerald/);
  });

  it.each([
    [0.004, "Up under 1% from the order before"],
    [-0.004, "Down under 1% from the order before"],
  ])("R6a: %s reads %s", async (value, text) => {
    const dialog = await open(history(value));
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/-0%|\b0%/);
  });

  it.each([
    [0.05, "Up 5% from the order before", "emerald"],
    [-0.05, "Down 5% from the order before", "amber"],
  ])("R6b: %s reads %s with its colour", async (value, text, colour) => {
    const dialog = await open(history(value));
    const el = await within(dialog).findByText(text);
    expect(el.className).toContain(colour);
  });

  it("R6b: null shows no change line", async () => {
    const dialog = await open(history(null));
    await within(dialog).findByText(/List \$14\.00/);
    expect(dialog.textContent).not.toMatch(/from the order before|since last order/);
  });
});

describe("price history rows at 390 (F4, F5)", () => {
  const pending = row({
    source: "ORDER",
    invoiceId: null,
    invoiceNumber: null,
    orderNumber: "ORD-2026-0000123456",
  });

  it("R12: the chip is nowrap on its own line and the cell does not truncate it", async () => {
    const dialog = await open(history(null, [pending]));
    const chip = await within(dialog).findByText("not invoiced yet");
    expect(chip.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(chip.className).toMatch(/\bblock\b/);
    const cell = chip.closest("td") as HTMLElement;
    expect(cell.className).not.toMatch(/\btruncate\b/);
    // the order number is what truncates
    const number = within(cell).getByText("ORD-2026-0000123456");
    expect(number.className).toMatch(/\btruncate\b/);
  });

  it("R12: Use is compact on a phone (auto width) and stays 44 px tall", async () => {
    const dialog = await open(history(null));
    const use = await within(dialog).findByRole("button", { name: /use this price/i });
    expect(use.className).not.toMatch(/(^|\s)w-full(\s|$)/);
    expect(use.className).toMatch(/min-h-\[44px\]/);
    expect((use.closest("td") as HTMLElement).className).not.toMatch(/(^|\s)w-full(\s|$)/);
  });
});
