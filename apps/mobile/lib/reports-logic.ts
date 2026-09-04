/**
 * Pure (screen-free, testable) helpers for the P10-PAR-6 mobile Finance Reports
 * parity screen: the report registry, date-range presets, and AR-aging bucket
 * shaping. Kept out of the RN screens so apps/mobile/__tests__/*.test.ts
 * (pure-logic, node env) can lock them.
 *
 * NO money math lives here — reports are READ-ONLY and server-computed; screens
 * render the returned totals directly. This file only shapes/labels data.
 */

// ─── Report registry ────────────────────────────────────────────────────────────

export type ReportId =
  "profit-loss" | "cashflow" | "sales-by-customer" | "sales-by-item" | "ar-aging";

/** Which control a report needs above its body: a date range, or an aging interval. */
export type ReportControl = "date" | "interval";

export interface ReportMeta {
  id: ReportId;
  label: string;
  description: string;
  group: string;
  control: ReportControl;
}

/** The v1 subset (5 high-value reports). The long tail of the web hub is deferred. */
export const REPORT_REGISTRY: ReportMeta[] = [
  {
    id: "profit-loss",
    label: "Profit & Loss",
    description: "Revenue, COGS, and expenses for a period",
    group: "Profit & Loss",
    control: "date",
  },
  {
    id: "cashflow",
    label: "Cash Flow",
    description: "Cash inflows and outflows for a period",
    group: "Profit & Loss",
    control: "date",
  },
  {
    id: "sales-by-customer",
    label: "Sales by Customer",
    description: "Total sales grouped by customer",
    group: "Sales",
    control: "date",
  },
  {
    id: "sales-by-item",
    label: "Sales by Item",
    description: "Total sales grouped by product",
    group: "Sales",
    control: "date",
  },
  {
    id: "ar-aging",
    label: "AR Aging",
    description: "Outstanding invoices by how long they've been due",
    group: "Receivables",
    control: "interval",
  },
];

export function reportMetaById(id: string | undefined): ReportMeta | undefined {
  return REPORT_REGISTRY.find((r) => r.id === id);
}

/** Registry grouped for the index screen, preserving registry order. */
export function reportGroups(): { group: string; reports: ReportMeta[] }[] {
  const groups: { group: string; reports: ReportMeta[] }[] = [];
  for (const r of REPORT_REGISTRY) {
    let g = groups.find((x) => x.group === r.group);
    if (!g) {
      g = { group: r.group, reports: [] };
      groups.push(g);
    }
    g.reports.push(r);
  }
  return groups;
}

// ─── Date-range presets ─────────────────────────────────────────────────────────

export type DateRangePreset = "This month" | "Last month" | "This quarter" | "This year";

export const DATE_PRESETS: DateRangePreset[] = [
  "This month",
  "Last month",
  "This quarter",
  "This year",
];

export const DEFAULT_PRESET: DateRangePreset = "This month";

/** Local-component YYYY-MM-DD (matches how the server reads `from`/`to`). */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Resolve a preset to `{ from, to }` ISO date strings, relative to `today`
 * (passed in so the result is deterministic and unit-testable).
 */
export function dateRangeForPreset(
  preset: DateRangePreset,
  today: Date,
): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case "This month":
      return { from: toISODate(new Date(y, m, 1)), to: toISODate(today) };
    case "Last month":
      // Day 0 of the current month = the last day of the previous month.
      return { from: toISODate(new Date(y, m - 1, 1)), to: toISODate(new Date(y, m, 0)) };
    case "This quarter": {
      const qStartMonth = Math.floor(m / 3) * 3;
      return { from: toISODate(new Date(y, qStartMonth, 1)), to: toISODate(today) };
    }
    case "This year":
      return { from: toISODate(new Date(y, 0, 1)), to: toISODate(today) };
  }
}

// ─── AR aging bucket shaping ────────────────────────────────────────────────────

export const AR_INTERVALS = [15, 30, 60] as const;
export const DEFAULT_AR_INTERVAL = 30;

/**
 * The five aging bucket columns for a given interval. Keys MUST match the
 * server's dynamic bucket naming (`bookkeeping.service.ts#getArAgingInvoices`):
 * `current`, `days1_<i>`, `days<i+1>_<2i>`, `days<2i+1>_<3i>`, `days<3i>plus`.
 * Labels are short for mobile.
 */
export function arAgingColumns(interval: number): { key: string; label: string }[] {
  return [
    { key: "current", label: "Current" },
    { key: `days1_${interval}`, label: `1–${interval}` },
    { key: `days${interval + 1}_${interval * 2}`, label: `${interval + 1}–${interval * 2}` },
    {
      key: `days${interval * 2 + 1}_${interval * 3}`,
      label: `${interval * 2 + 1}–${interval * 3}`,
    },
    { key: `days${interval * 3}plus`, label: `${interval * 3 + 1}+` },
  ];
}

interface ArAgingBucketEntry {
  customer: { id: string; businessName: string };
  balance: number;
}

export interface ArAgingCustomerRow {
  customerId: string;
  name: string;
  /** Per-bucket outstanding balance, keyed by the same keys as `arAgingColumns`. */
  buckets: Record<string, number>;
  total: number;
}

/**
 * Collapse the server's `buckets` object (bucket → invoice entries) into one row
 * per customer with per-bucket sums and a total, sorted by total desc. Mirrors
 * the web `ArAgingReport` `customerMap` build.
 */
export function arAgingCustomerRows(
  buckets: Record<string, ArAgingBucketEntry[]> | undefined,
): ArAgingCustomerRow[] {
  const map: Record<string, ArAgingCustomerRow> = {};
  for (const [bKey, entries] of Object.entries(buckets ?? {})) {
    for (const e of entries) {
      const id = e.customer.id;
      if (!map[id])
        map[id] = { customerId: id, name: e.customer.businessName, buckets: {}, total: 0 };
      map[id].buckets[bKey] = (map[id].buckets[bKey] ?? 0) + e.balance;
      map[id].total += e.balance;
    }
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}
