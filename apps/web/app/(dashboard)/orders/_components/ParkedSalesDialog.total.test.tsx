import * as React from "react";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ParkedSalesDialog } from "./ParkedSalesDialog";

/**
 * Row 330e: a parked-sale row shows its total. It is `cartTotals` (the live cart's own function, from
 * @routeflow/pricing) over the lines' pricing inputs at the tenant's configured tax rate; the row never re-derives a
 * line as qty x price (a boxed line priced that way over-charges by unitsPerBox).
 */
let mockSettings: Record<string, unknown> = { timezone: "UTC", taxRate: 10 };
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(() => Promise.resolve({ data: mockSettings })) },
}));

const ROW = {
  id: "p1",
  label: "Walk-in · 10:15",
  registerKey: "front",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  lineCount: 2,
};

function parkedWith(rows: unknown[]) {
  return {
    open: true,
    setOpen: jest.fn(),
    message: null,
    listFailed: false,
    listLoading: false,
    rows,
    retryList: jest.fn(),
    work: null,
    canResume: true,
    startResume: jest.fn(),
    discard: jest.fn(),
    prompt: null,
    choose: jest.fn(),
  } as never;
}

describe("ParkedSalesDialog: row total (row 330e)", () => {
  beforeEach(() => {
    mockSettings = { timezone: "UTC", taxRate: 10 };
  });

  it("shows each row's total from the pricing helpers, boxed lines prorated, tax at the tenant rate", async () => {
    renderWithProviders(
      <ParkedSalesDialog
        openerRef={{ current: null }}
        parked={parkedWith([
          {
            ...ROW,
            priceLines: [
              { unitPrice: 2.5, qty: 2 },
              // a box priced $12, 1 box + 3 of 6 loose pieces = 1.5 boxes = $18.00 (qty x price would say $108.00)
              { unitPrice: 12, qty: 9, boxes: 1, pieces: 3, unitsPerBox: 6 },
            ],
          },
        ])}
      />,
    );
    const row = await screen.findByTestId("parked-row-p1");
    // subtotal 5.00 + 18.00 = 23.00; tax 10% = 2.30; total 25.30
    // the span renders before /settings resolves (tax 0): wait for the taxed figure
    expect(await within(row).findByText("$25.30")).toHaveAttribute(
      "data-testid",
      "parked-row-total",
    );
    expect(row).not.toHaveTextContent("$108.00");
  });

  it("an untaxed tenant shows the subtotal as the total", async () => {
    mockSettings = { timezone: "UTC", taxRate: 0 };
    renderWithProviders(
      <ParkedSalesDialog
        openerRef={{ current: null }}
        parked={parkedWith([{ ...ROW, priceLines: [{ unitPrice: 4, qty: 3 }] }])}
      />,
    );
    expect(await screen.findByText("$12.00")).toHaveAttribute("data-testid", "parked-row-total");
  });

  it("a row whose price lines are empty shows no total rather than $0.00", async () => {
    renderWithProviders(
      <ParkedSalesDialog
        openerRef={{ current: null }}
        parked={parkedWith([{ ...ROW, priceLines: [] }])}
      />,
    );
    await screen.findByTestId("parked-row-p1");
    expect(screen.queryByTestId("parked-row-total")).toBeNull();
  });

  it("a row with no price lines (an older server) shows no total rather than $0.00", async () => {
    renderWithProviders(
      <ParkedSalesDialog openerRef={{ current: null }} parked={parkedWith([ROW])} />,
    );
    await screen.findByTestId("parked-row-p1");
    expect(screen.queryByTestId("parked-row-total")).toBeNull();
  });
});
