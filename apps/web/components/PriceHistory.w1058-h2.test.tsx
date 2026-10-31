import * as React from "react";
import { renderWithProviders, screen, waitFor, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type {
  PriceHistoryComparisonLine,
  PriceHistoryResponse,
  PriceHistoryRow,
} from "@/lib/api/price-history";

/**
 * W-1058 H-2 (SA-1069 A-2 section 2), the web half: every real month the server sends is drawn, as ONE polyline per line
 * oldest to newest with a marker on each real month; a line ends at its newest month; the chart names its first and last
 * month; the own line reads the compare query's 100 rows while the table keeps the base query's 25; the panel names how
 * old its figures are; and no note claims a floor of 3.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-10T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 25,
  unitLabel: "Box",
  unitsPerBox: 12,
  salePack: 12,
  qty: 2,
  boxes: 2,
  pieces: 0,
  avgCostAtSale: null,
  invoiceId: "inv-1",
  invoiceNumber: "INV-1",
  orderId: "o-1",
  orderNumber: "ORD-1",
  priceType: null,
  ...over,
});
const entry = (over: Partial<PriceHistoryComparisonLine> = {}): PriceHistoryComparisonLine => ({
  unitLabel: "Box",
  unitsPerBox: 12,
  likeForLike: [{ month: "2026-09", average: 24.5 }],
  converted: [{ month: "2026-09", average: 25.11 }],
  ...over,
});
const data = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  rows: [
    row({ date: "2026-08-10T00:00:00.000Z", unitPrice: 24, invoiceNumber: "INV-A", orderId: "a" }),
    row({ invoiceNumber: "INV-B", orderId: "b" }),
  ],
  summaries: [{ unitLabel: "Box", last: 25, low: 24, high: 25, qtySold: 4, currentAvgCost: null }],
  references: { listPrice: null, tierPrice: null, changeSinceLast: null },
  aggregate: null,
  comparison: [entry()],
  ...over,
});

/** The base request carries no comparison and 25 rows at most; `?compare=all` adds them (as the server does). */
const serve = (base: PriceHistoryResponse, cmp: PriceHistoryResponse = base) =>
  mockGet.mockImplementation((_url: string, cfg?: { params?: { compare?: string } }) => {
    if (cfg?.params?.compare !== "all") {
      const { aggregate: _a, comparison: _c, ...plain } = base;
      return Promise.resolve({ data: plain });
    }
    return Promise.resolve({ data: cmp });
  });

const open = async () => {
  renderWithProviders(
    <PriceHistoryButton
      customerId="c1"
      customerName="Acme Foods"
      productId="p1"
      productName="Cola"
      onUsePrice={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Price history" }));
  const dialog = await screen.findByRole("dialog", { name: "Price history" });
  await waitFor(() => expect(within(dialog).queryByText("Loading averages…")).toBeNull());
  return dialog;
};
const line = (dialog: HTMLElement, id: "own" | "like" | "conv") =>
  within(dialog).getByTestId(`line-${id}`);
const xs = (poly: Element) =>
  poly
    .getAttribute("points")!
    .split(" ")
    .map((p) => Number(p.split(",")[0]));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("H8 / H-2.2: sales in Jan and Apr, nothing between", () => {
  it("each reference line is ONE polyline with a marker on each real month, nothing in Feb or Mar", async () => {
    serve(
      data({
        comparison: [
          entry({
            likeForLike: [
              { month: "2026-01", average: 23 },
              { month: "2026-04", average: 24 },
            ],
            converted: [
              { month: "2026-01", average: 25 },
              { month: "2026-04", average: 26 },
            ],
          }),
        ],
      }),
    );
    const dialog = await open();
    expect(line(dialog, "like").querySelectorAll("polyline")).toHaveLength(1);
    expect(line(dialog, "conv").querySelectorAll("polyline")).toHaveLength(1);
    expect(within(dialog).getAllByTestId("mark-like")).toHaveLength(2);
    expect(within(dialog).getAllByTestId("mark-conv")).toHaveLength(2);
    // line 2 marks are squares, line 3 marks are circles
    expect(within(dialog).getAllByTestId("mark-like")[0]!.tagName).toBe("rect");
    expect(within(dialog).getAllByTestId("mark-conv")[0]!.tagName).toBe("circle");
    expect(line(dialog, "like").querySelectorAll("rect")).toHaveLength(2);
  });
});

describe("H9 / H-2.4: one point", () => {
  it("is a marker with no line, and its chip shows the value and the month", async () => {
    serve(data({ comparison: [entry()] }));
    const dialog = await open();
    expect(line(dialog, "like").querySelector("polyline")).toBeNull();
    expect(line(dialog, "conv").querySelector("polyline")).toBeNull();
    expect(within(dialog).getAllByTestId("mark-like")).toHaveLength(1);
    expect(within(dialog).getAllByTestId("mark-conv")).toHaveLength(1);
    expect(within(dialog).getByTestId("chip-like")).toHaveTextContent("$24.50");
    expect(within(dialog).getByTestId("chip-like")).toHaveTextContent("Sep 2026");
    expect(within(dialog).getByTestId("chip-conv")).toHaveTextContent("$25.11");
    expect(within(dialog).getByTestId("chip-conv")).toHaveTextContent("Sep 2026");
  });
});

describe("H-2.3: a line ends at its newest month", () => {
  it("line 2 stops at Aug while line 1 runs on to Sep: never extended to the right edge", async () => {
    serve(
      data({
        comparison: [
          entry({
            likeForLike: [
              { month: "2026-07", average: 23 },
              { month: "2026-08", average: 24 },
            ],
          }),
        ],
      }),
    );
    const dialog = await open();
    const likeX = xs(line(dialog, "like").querySelector("polyline")!);
    const ownX = xs(line(dialog, "own").querySelector("polyline")!);
    expect(Math.max(...likeX)).toBeLessThan(Math.max(...ownX));
  });
});

describe("H15 / H-2.6: the chart names its first and last month", () => {
  it("over a span of more than a year: start and end month under the plot", async () => {
    serve(
      data({
        rows: [
          row({ date: "2024-11-10T00:00:00.000Z", unitPrice: 22, invoiceNumber: "INV-A" }),
          row({ date: "2026-03-10T00:00:00.000Z", unitPrice: 25, invoiceNumber: "INV-B" }),
        ],
        comparison: [
          entry({
            likeForLike: [{ month: "2026-03", average: 24 }],
            converted: [{ month: "2025-01", average: 23 }],
          }),
        ],
      }),
    );
    const dialog = await open();
    const axis = within(dialog).getByTestId("chart-axis");
    expect(axis).toHaveTextContent("Nov 2024");
    expect(axis).toHaveTextContent("Mar 2026");
  });

  it("one point in one month: the month once", async () => {
    serve(data({ rows: [row({ invoiceNumber: "INV-B" })], comparison: [entry()] }));
    const dialog = await open();
    expect(within(dialog).getByTestId("chart-axis").textContent).toBe("Sep 2026");
  });
});

describe("H16 / H-2.7: the own line reads the compare query, the table the base query", () => {
  const forty = Array.from({ length: 40 }, (_, i) =>
    row({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      unitPrice: 20 + i / 10,
      invoiceNumber: `INV-${String(i).padStart(2, "0")}`,
      orderId: `o-${i}`,
    }),
  );

  it("40 own sales: the line carries 40 dots, the table lists the base query's 25", async () => {
    const newest25 = [...forty].reverse().slice(0, 25).reverse();
    serve(data({ rows: newest25 }), data({ rows: forty }));
    const dialog = await open();
    await waitFor(() => expect(within(dialog).getAllByTestId("own-dot")).toHaveLength(40));
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(25);
  });

  it("asks for 100 rows on the compare query and 25 on the base query", async () => {
    serve(data());
    await open();
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/products/p1/price-history", {
      params: { limit: 25 },
    });
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/products/p1/price-history", {
      params: { limit: 100, compare: "all" },
    });
  });
});

describe("H12 / H-2.8: the panel says how old its figures are", () => {
  it("names the customer count with countNoun, six months, and the newest month", async () => {
    serve(
      data({
        aggregate: {
          low: 9,
          median: 9,
          high: 9,
          customers: 1,
          unitLabel: "Box",
          newestMonth: "2026-03",
        },
      }),
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "All customers", pressed: false }));
    const panel = await within(dialog).findByTestId("compare-panel");
    expect(panel).toHaveTextContent(
      "1 other customer, 6 months to Mar 2026. Names are never shown.",
    );
  });

  it("plural for several customers", async () => {
    serve(
      data({
        aggregate: {
          low: 9,
          median: 11,
          high: 15,
          customers: 7,
          unitLabel: "Box",
          newestMonth: "2026-09",
        },
      }),
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "All customers", pressed: false }));
    expect(await within(dialog).findByTestId("compare-panel")).toHaveTextContent(
      "7 other customers, 6 months to Sep 2026. Names are never shown.",
    );
  });
});

describe("H-2.9: the notes", () => {
  it("line 2 empty: the copy is verbatim and no floor of 3 is mentioned", async () => {
    serve(data({ comparison: [entry({ likeForLike: [] })] }));
    const dialog = await open();
    expect(
      within(dialog).getByText("All customers: nothing to compare in Box of 12 yet."),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/3 other|other buyers/);
  });

  it("line 3 empty", async () => {
    serve(data({ comparison: [entry({ converted: [] })] }));
    const dialog = await open();
    expect(within(dialog).getByText("All units: nothing to compare yet.")).toBeInTheDocument();
  });

  it("both empty, and never sold: one 'Nothing to compare yet.'", async () => {
    serve(data({ comparison: [entry({ likeForLike: [], converted: [] })] }));
    const dialog = await open();
    expect(within(dialog).getAllByText("Nothing to compare yet.")).toHaveLength(1);
    expect(dialog.textContent).not.toMatch(/3 other|other buyers|No averages yet/);
  });
});
