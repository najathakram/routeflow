import { roundMoney } from "@routeflow/pricing";
import type { TodaysSalesSummary } from "@routeflow/types";

/**
 * "Last 7 days" on Today's sales (Train 4 b): seven calls to the existing `GET .../today?day=` endpoint, one summary per day.
 * The server owns every figure; the week total is the sum of the daily figures in cents (`roundMoney`), nothing else is derived.
 */

/** `n` calendar days ending on `day` ("YYYY-MM-DD", the tenant's own day from `meta.day`), newest first. */
export function lastDays(day: string, n = 7): string[] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: n }, (_, i) =>
    new Date(base - i * 86_400_000).toISOString().slice(0, 10),
  );
}

const add = (a: number, b: number) => roundMoney(a + b);

export function sumWeek(summaries: readonly TodaysSalesSummary[]): TodaysSalesSummary {
  const zero: TodaysSalesSummary = {
    sales: { count: 0, total: 0 },
    moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
    storeCreditUsed: 0,
    onAccount: 0,
    refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: true },
    storeCreditIssued: { count: 0, amount: 0 },
    cashExpectedInDrawer: 0,
    netCollected: 0,
  };
  return summaries.reduce<TodaysSalesSummary>(
    (t, s) => ({
      sales: { count: t.sales.count + s.sales.count, total: add(t.sales.total, s.sales.total) },
      moneyIn: {
        cash: add(t.moneyIn.cash, s.moneyIn.cash),
        card: add(t.moneyIn.card, s.moneyIn.card),
        check: add(t.moneyIn.check, s.moneyIn.check),
        other: add(t.moneyIn.other, s.moneyIn.other),
        total: add(t.moneyIn.total, s.moneyIn.total),
      },
      storeCreditUsed: add(t.storeCreditUsed, s.storeCreditUsed),
      onAccount: add(t.onAccount, s.onAccount),
      refunds: {
        count: t.refunds.count + s.refunds.count,
        cash: add(t.refunds.cash, s.refunds.cash),
        card: add(t.refunds.card, s.refunds.card),
        check: add(t.refunds.check, s.refunds.check),
        other: add(t.refunds.other, s.refunds.other),
        total: add(t.refunds.total, s.refunds.total),
        tenderKnown: t.refunds.tenderKnown && s.refunds.tenderKnown,
      },
      storeCreditIssued: {
        count: t.storeCreditIssued.count + s.storeCreditIssued.count,
        amount: add(t.storeCreditIssued.amount, s.storeCreditIssued.amount),
      },
      cashExpectedInDrawer: add(t.cashExpectedInDrawer, s.cashExpectedInDrawer),
      netCollected: add(t.netCollected, s.netCollected),
    }),
    zero,
  );
}

const CSV_HEADER = [
  "Day",
  "Sales",
  "Sales total",
  "Cash in",
  "Card in",
  "Check in",
  "Other in",
  "Money in",
  "Store credit used",
  "On account",
  "Refunds",
  "Cash refunds",
  "Card refunds",
  "Check refunds",
  "Other refunds",
  "Store credit issued",
  "Cash expected",
  "Net collected",
];
const amount = (n: number) => n.toFixed(2);

function csvRow(label: string, s: TodaysSalesSummary): string[] {
  return [
    csvText(label),
    String(s.sales.count),
    amount(s.sales.total),
    amount(s.moneyIn.cash),
    amount(s.moneyIn.card),
    amount(s.moneyIn.check),
    amount(s.moneyIn.other),
    amount(s.moneyIn.total),
    amount(s.storeCreditUsed),
    amount(s.onAccount),
    amount(s.refunds.total),
    amount(s.refunds.cash),
    amount(s.refunds.card),
    amount(s.refunds.check),
    amount(s.refunds.other),
    amount(s.storeCreditIssued.amount),
    amount(s.cashExpectedInDrawer),
    amount(s.netCollected),
  ];
}

/**
 * A TEXT cell that starts with = + - @ (or a tab / CR) would run as a formula when the file is opened in a spreadsheet:
 * it is prefixed with an apostrophe. Numbers (a plain negative like -5.00) never go through here.
 */
export const csvText = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * One row per day (oldest first) and a Total row. Plain numbers (two decimals, no currency symbol or thousands separator) so
 * a spreadsheet can sum them. A week with refunds that carry no recorded method adds a final note line.
 */
export function weekCsv(days: ReadonlyArray<{ day: string; summary: TodaysSalesSummary }>): string {
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const total = sumWeek(ordered.map((d) => d.summary));
  const rows = [
    CSV_HEADER,
    ...ordered.map((d) => csvRow(d.day, d.summary)),
    csvRow("Total", total),
  ];
  const lines = rows.map((r) => r.map(cell).join(","));
  if (!total.refunds.tenderKnown) {
    lines.push(
      cell(
        "Note: some refunds have no recorded method (refund method not recorded), so cash expected is before those refunds.",
      ),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
