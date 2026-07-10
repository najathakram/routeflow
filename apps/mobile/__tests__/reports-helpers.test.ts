/**
 * P10-PAR-6 pure-logic guards for the mobile Finance Reports parity screen.
 * Locks the report registry/grouping, the date-range presets (deterministic via
 * an injected `today`), and the AR-aging bucket shaping — the column KEYS must
 * match the server's dynamic bucket naming, and per-customer rows must fold +
 * sort correctly.
 */
import {
  arAgingColumns,
  arAgingCustomerRows,
  AR_INTERVALS,
  DATE_PRESETS,
  dateRangeForPreset,
  DEFAULT_AR_INTERVAL,
  DEFAULT_PRESET,
  reportGroups,
  reportMetaById,
  REPORT_REGISTRY,
} from "../lib/reports-logic";

describe("report registry", () => {
  it("has the 5 v1 reports with unique ids", () => {
    expect(REPORT_REGISTRY).toHaveLength(5);
    const ids = REPORT_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });
  it("reportMetaById resolves and returns undefined for unknown", () => {
    expect(reportMetaById("cashflow")?.label).toBe("Cash Flow");
    expect(reportMetaById("nope")).toBeUndefined();
    expect(reportMetaById(undefined)).toBeUndefined();
  });
  it("groups reports preserving registry order without dropping any", () => {
    const groups = reportGroups();
    const flat = groups.flatMap((g) => g.reports.map((r) => r.id));
    expect(flat).toEqual(REPORT_REGISTRY.map((r) => r.id));
    // AR aging is the only interval-controlled report; the rest are date-driven.
    expect(reportMetaById("ar-aging")?.control).toBe("interval");
    expect(reportMetaById("profit-loss")?.control).toBe("date");
  });
});

describe("dateRangeForPreset (deterministic via injected today)", () => {
  // Wed 2026-07-15 — mid-month, Q3.
  const today = new Date(2026, 6, 15);
  it.each([
    ["This month", { from: "2026-07-01", to: "2026-07-15" }],
    ["Last month", { from: "2026-06-01", to: "2026-06-30" }],
    ["This quarter", { from: "2026-07-01", to: "2026-07-15" }],
    ["This year", { from: "2026-01-01", to: "2026-07-15" }],
  ] as const)("%s → %o", (preset, expected) => {
    expect(dateRangeForPreset(preset, today)).toEqual(expected);
  });

  it("Last month rolls the year back across January", () => {
    expect(dateRangeForPreset("Last month", new Date(2026, 0, 10))).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("This quarter anchors to the quarter start (Q1 for February)", () => {
    expect(dateRangeForPreset("This quarter", new Date(2026, 1, 20))).toEqual({
      from: "2026-01-01",
      to: "2026-02-20",
    });
  });

  it("exposes the presets and a valid default", () => {
    expect(DATE_PRESETS).toContain(DEFAULT_PRESET);
  });
});

describe("arAgingColumns — keys mirror the server bucket naming", () => {
  it("interval 30 → the default bucket keys", () => {
    expect(arAgingColumns(30).map((c) => c.key)).toEqual([
      "current",
      "days1_30",
      "days31_60",
      "days61_90",
      "days90plus",
    ]);
  });
  it("interval 15 → shifts every window", () => {
    expect(arAgingColumns(15).map((c) => c.key)).toEqual([
      "current",
      "days1_15",
      "days16_30",
      "days31_45",
      "days45plus",
    ]);
  });
  it("default interval is a valid choice", () => {
    expect(AR_INTERVALS).toContain(DEFAULT_AR_INTERVAL as (typeof AR_INTERVALS)[number]);
  });
});

describe("arAgingCustomerRows", () => {
  const buckets = {
    current: [{ customer: { id: "c1", businessName: "Acme" }, balance: 100 }],
    days1_30: [
      { customer: { id: "c1", businessName: "Acme" }, balance: 50 },
      { customer: { id: "c2", businessName: "Beta" }, balance: 400 },
    ],
    days31_60: [] as { customer: { id: string; businessName: string }; balance: number }[],
  };

  it("folds a customer's balances across buckets and totals them", () => {
    const rows = arAgingCustomerRows(buckets);
    const acme = rows.find((r) => r.customerId === "c1")!;
    expect(acme.buckets).toEqual({ current: 100, days1_30: 50 });
    expect(acme.total).toBe(150);
  });

  it("sorts customers by total descending", () => {
    const rows = arAgingCustomerRows(buckets);
    expect(rows.map((r) => r.customerId)).toEqual(["c2", "c1"]);
  });

  it("returns [] for empty / undefined input", () => {
    expect(arAgingCustomerRows(undefined)).toEqual([]);
    expect(arAgingCustomerRows({})).toEqual([]);
  });
});
