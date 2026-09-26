import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ProductInsightsResponse, ProductInsightSaleLine } from "@routeflow/types";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductInsightsPanel } from "./ProductInsightsPanel";

/**
 * #2119 — the product insights panel formats what #2179 computed. Pinned: tiles, buyers
 * (sortable; a row filters the lines and links to customer insights), line badges and paging,
 * CSV for the window on screen, and the never-sold / empty / error / inactive / mixed-pack states.
 */
const mockInsights = jest.fn();
const mockLines = jest.fn();
const mockMutate = jest.fn();
jest.mock("@/lib/api/product-insights", () => ({
  useProductInsights: (...args: unknown[]) => mockInsights(...args),
  useProductSalesLines: (...args: unknown[]) => mockLines(...args),
  useExportProductInsightsCsv: () => ({ mutate: mockMutate, isPending: false, isError: false }),
}));

function payload(over: Partial<ProductInsightsResponse> = {}): ProductInsightsResponse {
  return {
    product: {
      id: "p1",
      name: "Sparkling Water 12pk",
      sku: "SW-12",
      unitSku: null,
      barcode: null,
      unitsPerBox: 12,
      unitLabel: "case",
      isActive: true,
    },
    window: { from: "2025-10-01", to: "2026-09-26", grain: "month", timezone: "UTC" },
    basis: "accrual_net",
    totals: {
      invoicedQtyPieces: 480,
      unresolvedSaleLines: 1,
      returnedQtyPieces: 12,
      unresolvedReturnLines: 0,
      netQtyPieces: 468,
      sellingUnits: 40,
      sellingUnitPack: 12,
      legacyLines: 0,
      mixedPackSizes: false,
      lineGross: 960,
      attributedCredits: 24,
      lineNet: 936,
      unattributedCredits: 7.5,
      invoices: 20,
      orders: 18,
      buyers: 2,
      firstSaleAt: "2025-10-03",
      lastSaleAt: "2026-09-19",
    },
    price: {
      avgPerPiece: 2,
      avgPerSellingUnit: 24,
      last: {
        unitPrice: 24,
        unitLabel: "case",
        unitsPerBox: 12,
        perPiece: 2,
        date: "2026-09-19",
        customerId: "c1",
        customer: "Acme Deli",
      },
      minPerPiece: 1.8,
      maxPerPiece: 2.25,
    },
    series: [
      {
        date: "2026-09-01",
        qtyPieces: 48,
        returnedQtyPieces: 0,
        lineGross: 96,
        credits: 0,
        lineNet: 96,
        avgPerPiece: 2,
      },
    ],
    buyers: [
      {
        customerId: "c1",
        name: "Acme Deli",
        qtyPieces: 360,
        lineGross: 720,
        lineNet: 700,
        orders: 12,
        lastDate: "2026-09-19",
        lastPerPiece: 2,
        avgPerPiece: 2,
        share: 0.75,
      },
      {
        customerId: "c2",
        name: "Bayside Market",
        qtyPieces: 120,
        lineGross: 240,
        lineNet: 236,
        orders: 6,
        lastDate: "2026-08-02",
        lastPerPiece: 2,
        avgPerPiece: 2,
        share: 0.25,
      },
    ],
    buyersTotal: 2,
    ...over,
  };
}

const line = (over: Partial<ProductInsightSaleLine> = {}): ProductInsightSaleLine => ({
  lineId: "l1",
  date: "2026-09-19T00:00:00.000Z",
  invoiceId: "inv1",
  invoiceNumber: "INV-1001",
  orderId: null,
  orderNumber: null,
  customerId: "c1",
  customerName: "Acme Deli",
  qty: 24,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 12,
  unitPrice: 24,
  lineTotal: 48,
  originalPrice: 26,
  overridden: true,
  writtenOff: true,
  unitLabel: "case",
  perPiece: 2,
  creditedAmount: 4,
  returnedQty: 0,
  ...over,
});

const ok = (data: ProductInsightsResponse) => ({
  data,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: jest.fn(),
});

const linesOk = (lines: ProductInsightSaleLine[], more = false) => ({
  data: { pages: [{ productId: "p1", window: payload().window, lines, nextCursor: null }] },
  isLoading: false,
  isError: false,
  hasNextPage: more,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
  refetch: jest.fn(),
});

function renderPanel() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProductInsightsPanel productId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockInsights.mockReset();
  mockLines.mockReset();
  mockMutate.mockReset();
  mockLines.mockReturnValue(linesOk([line()]));
});

describe("ProductInsightsPanel (#2119)", () => {
  it("renders tiles in pieces with the current-pack split, net sales, price facts and footnotes", () => {
    mockInsights.mockReturnValue(ok(payload()));
    renderPanel();
    expect(screen.getByText("468 pcs (39 boxes)")).toBeInTheDocument();
    expect(screen.getByText("$936.00")).toBeInTheDocument();
    expect(screen.getByText("$2.00/pc")).toBeInTheDocument();
    expect(
      screen.getByText(/Last sold Sep 19, 2026 to Acme Deli at \$24.00 per case/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\$7\.50 of credits on these invoices are not tied to a line/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 older line with an unknown piece count is in sales/),
    ).toBeInTheDocument();
  });

  it("buyers: link to customer insights, sort by a header, and a row filters the lines", () => {
    mockInsights.mockReturnValue(ok(payload()));
    renderPanel();
    const buyers = screen.getByRole("region", { name: "Buyers" });
    expect(within(buyers).getByRole("link", { name: "Acme Deli" })).toHaveAttribute(
      "href",
      "/insights/customers/c1",
    );
    const names = () =>
      within(buyers)
        .getAllByRole("link")
        .map((a) => a.textContent);
    expect(names()).toEqual(["Acme Deli", "Bayside Market"]);
    fireEvent.click(within(buyers).getByRole("button", { name: /^Buyer/ }));
    expect(names()).toEqual(["Acme Deli", "Bayside Market"]); // A→Z
    fireEvent.click(within(buyers).getByRole("button", { name: /^Buyer/ }));
    expect(names()).toEqual(["Bayside Market", "Acme Deli"]); // Z→A

    fireEvent.click(within(buyers).getAllByRole("button", { name: "Show their lines" })[0]);
    const lastCall = mockLines.mock.calls[mockLines.mock.calls.length - 1];
    expect(lastCall[1]).toMatchObject({ customerId: "c2", from: "2025-10-01", to: "2026-09-26" });
    expect(screen.getByRole("button", { name: /Bayside Market ✕/ })).toBeInTheDocument();
  });

  it("lines: written-off, re-priced and credited badges; load more when there is a next page", () => {
    mockInsights.mockReturnValue(ok(payload()));
    const lines = linesOk([line()], true);
    mockLines.mockReturnValue(lines);
    renderPanel();
    const section = screen.getByRole("region", { name: "Sold lines" });
    expect(within(section).getByText("Written off")).toBeInTheDocument();
    expect(within(section).getByText("Re-priced")).toBeInTheDocument();
    expect(within(section).getByText("Credited $4.00")).toBeInTheDocument();
    expect(within(section).getByText("$26.00")).toBeInTheDocument(); // struck-through list price
    fireEvent.click(within(section).getByRole("button", { name: "Load more" }));
    expect(lines.fetchNextPage).toHaveBeenCalled();
  });

  it("exports the CSV for the window on screen (and the buyer filter when set)", () => {
    mockInsights.mockReturnValue(ok(payload()));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(mockMutate).toHaveBeenCalledWith({
      productId: "p1",
      from: "2025-10-01",
      to: "2026-09-26",
      customerId: undefined,
      filename: "product-sales-SW-12-2025-10-01-to-2026-09-26.csv",
    });
  });

  it("never sold is terminal: no tiles, no lines", () => {
    const p = payload();
    p.totals = { ...p.totals, firstSaleAt: null, lastSaleAt: null, invoices: 0 };
    mockInsights.mockReturnValue(ok(p));
    renderPanel();
    expect(screen.getByText("Never sold")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sold lines" })).not.toBeInTheDocument();
  });

  it("empty window: says when it last sold and offers 24 months", () => {
    const p = payload();
    p.totals = { ...p.totals, invoices: 0, attributedCredits: 0 };
    mockInsights.mockReturnValue(ok(p));
    renderPanel();
    expect(screen.getByText("No sales in this period.")).toBeInTheDocument();
    expect(screen.getByText("Last sold Sep 19, 2026.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View the last 24 months" }));
    expect(screen.getByRole("button", { name: "Last 24 months" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("inactive product and mixed pack sizes are called out", () => {
    const p = payload({ product: { ...payload().product, isActive: false } });
    p.totals = { ...p.totals, mixedPackSizes: true, sellingUnitPack: null };
    mockInsights.mockReturnValue(ok(p));
    renderPanel();
    expect(screen.getByText(/This product is inactive/)).toBeInTheDocument();
    expect(screen.getByText(/Sold in more than one pack size/)).toBeInTheDocument();
  });

  it("error: retry", () => {
    const refetch = jest.fn();
    mockInsights.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});
