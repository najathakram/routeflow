import { ANALYTICS_CSV, analyticsCsvFilename } from "./analytics-csv";

const EVIL = "=cmd|' /C calc'!A0";

describe("analytics-csv column specs", () => {
  it("revenue-trend", () => {
    const s = ANALYTICS_CSV["revenue-trend"];
    expect(s.headers).toEqual(["Period", "Revenue"]);
    expect(s.rows([{ period: "2026-08", revenue: 1234.5 }])).toEqual([["2026-08", 1234.5]]);
  });

  it("aov is one row, blank when null", () => {
    const s = ANALYTICS_CSV["aov"];
    expect(s.headers).toEqual(["Average order value"]);
    expect(s.rows(87.25)).toEqual([[87.25]]);
    expect(s.rows(null)).toEqual([]);
  });

  it("dso", () => {
    const s = ANALYTICS_CSV["dso"];
    expect(s.headers).toEqual(["DSO (days)", "Invoices counted"]);
    expect(s.rows({ dso: 31.4, count: 12 })).toEqual([[31.4, 12]]);
    expect(s.rows(null)).toEqual([]);
  });

  it("gross-margin", () => {
    const s = ANALYTICS_CSV["gross-margin"];
    expect(s.headers).toEqual(["Revenue", "COGS", "Gross profit", "Gross margin %"]);
    expect(s.rows({ revenue: 100, cogs: 60, grossProfit: 40, grossMarginPct: 40 })).toEqual([
      [100, 60, 40, 40],
    ]);
    expect(s.rows(null)).toEqual([]);
  });

  it("sales-by-category exports every category, not the chart's Other bucket", () => {
    const s = ANALYTICS_CSV["sales-by-category"];
    expect(s.headers).toEqual(["Category", "Revenue"]);
    const many = Array.from({ length: 10 }, (_, i) => ({ category: `C${i}`, revenue: 10 - i }));
    expect(s.rows(many)).toHaveLength(10);
    expect(s.rows([{ category: EVIL, revenue: 5 }])).toEqual([[EVIL, 5]]);
  });

  it("top-products keeps the injection-prone name raw (downloadCsv guards it)", () => {
    const s = ANALYTICS_CSV["top-products"];
    expect(s.headers).toEqual(["Product", "Revenue", "Units sold"]);
    expect(s.rows([{ id: "1", name: EVIL, totalRevenue: 9.99, unitsSold: 3 }])).toEqual([
      [EVIL, 9.99, 3],
    ]);
  });

  it("inventory-turnover", () => {
    const s = ANALYTICS_CSV["inventory-turnover"];
    expect(s.headers).toEqual(["Product", "Units sold", "Current stock", "Turnover rate"]);
    expect(
      s.rows([{ id: "1", name: "Cola", unitsSold: 8, currentStock: 2, turnoverRate: 4 }]),
    ).toEqual([["Cola", 8, 2, 4]]);
  });

  it("dead-stock: dates as YYYY-MM-DD, blanks for never/unknown", () => {
    const s = ANALYTICS_CSV["dead-stock"];
    expect(s.headers).toEqual(["Product", "Stock", "Last movement", "Days inactive"]);
    expect(
      s.rows([
        {
          id: "1",
          name: "A",
          currentStock: 5,
          lastMovement: "2026-03-04T10:20:30.000Z",
          daysInactive: 200,
        },
        { id: "2", name: "B", currentStock: 1, lastMovement: null, daysInactive: null },
      ]),
    ).toEqual([
      ["A", 5, "2026-03-04", 200],
      ["B", 1, "", ""],
    ]);
  });

  it("margin-alerts", () => {
    const s = ANALYTICS_CSV["margin-alerts"];
    expect(s.headers).toEqual(["Product", "Price", "Cost", "Margin %"]);
    expect(s.rows([{ id: "1", name: "A", price: 2, cost: 1.9, marginPct: 5 }])).toEqual([
      ["A", 2, 1.9, 5],
    ]);
  });

  it("top-customers adds the displayed rank", () => {
    const s = ANALYTICS_CSV["top-customers"];
    expect(s.headers).toEqual(["#", "Customer", "Total revenue", "Orders"]);
    expect(
      s.rows([
        { id: "1", name: "Acme", totalRevenue: 500, orderCount: 4 },
        { id: "2", name: EVIL, totalRevenue: 100, orderCount: 1 },
      ]),
    ).toEqual([
      [1, "Acme", 500, 4],
      [2, EVIL, 100, 1],
    ]);
  });

  it("route-performance keeps null ops metrics blank, not zero", () => {
    const s = ANALYTICS_CSV["route-performance"];
    expect(s.headers).toEqual([
      "Route",
      "Total runs",
      "Completed",
      "Completion rate %",
      "On-time %",
      "Stops/hr",
      "Avg duration (min)",
    ]);
    expect(
      s.rows([
        {
          id: "1",
          name: "North",
          totalRuns: 10,
          completedRuns: 9,
          completionRate: 90,
          onTimeRate: 95,
          stopsPerHour: 6.5,
          avgRunDurationMinutes: 83,
        },
        {
          id: "2",
          name: "South",
          totalRuns: 1,
          completedRuns: 0,
          completionRate: 0,
          onTimeRate: null,
          stopsPerHour: null,
          avgRunDurationMinutes: null,
        },
      ]),
    ).toEqual([
      ["North", 10, 9, 90, 95, 6.5, 83],
      ["South", 1, 0, 0, "", "", ""],
    ]);
  });

  it("driver-performance", () => {
    const s = ANALYTICS_CSV["driver-performance"];
    expect(s.headers).toEqual([
      "Driver",
      "Total deliveries",
      "Completed",
      "Completion rate %",
      "On-time %",
      "Stops/hr",
      "Avg duration (min)",
    ]);
    expect(
      s.rows([
        {
          id: "1",
          name: "Dee",
          totalDeliveries: 20,
          completedDeliveries: 19,
          completionRate: 95,
          onTimeRate: 80,
          stopsPerHour: 7,
          avgRunDurationMinutes: 61,
        },
      ]),
    ).toEqual([["Dee", 20, 19, 95, 80, 7, 61]]);
  });
});

describe("analyticsCsvFilename", () => {
  it("uses the applied range", () => {
    expect(analyticsCsvFilename("top-products", "2026-01-01", "2026-01-31")).toBe(
      "analytics-top-products-2026-01-01-to-2026-01-31.csv",
    );
  });
});
