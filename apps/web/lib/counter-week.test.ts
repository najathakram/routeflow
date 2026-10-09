import type { TodaysSalesSummary } from "@routeflow/types";
import { lastDays, sumWeek, weekCsv } from "./counter-week";

/**
 * Train 4 (b): "Last 7 days" on Today's sales. Seven calls to the existing day endpoint, one summary each; the week total is
 * the rounded sum of the server's daily figures (cents, never float drift), and the CSV carries one row per day plus a total.
 */
const summary = (over: Partial<TodaysSalesSummary> = {}): TodaysSalesSummary => ({
  sales: { count: 2, total: 20.1 },
  moneyIn: { cash: 10.1, card: 5, check: 0, other: 0, total: 15.1 },
  storeCreditUsed: 1,
  onAccount: 4,
  refunds: { count: 1, cash: 2.2, card: 0, check: 0, other: 0, total: 2.2, tenderKnown: true },
  storeCreditIssued: { count: 0, amount: 0 },
  cashExpectedInDrawer: 7.9,
  netCollected: 12.9,
  ...over,
});

describe("lastDays", () => {
  it("lists seven calendar days newest first, ending on the tenant's day", () => {
    expect(lastDays("2026-10-09")).toEqual([
      "2026-10-09",
      "2026-10-08",
      "2026-10-07",
      "2026-10-06",
      "2026-10-05",
      "2026-10-04",
      "2026-10-03",
    ]);
  });
  it("crosses month and year ends and a leap day", () => {
    expect(lastDays("2026-03-02", 3)).toEqual(["2026-03-02", "2026-03-01", "2026-02-28"]);
    expect(lastDays("2024-03-01", 2)).toEqual(["2024-03-01", "2024-02-29"]);
    expect(lastDays("2026-01-02", 3)).toEqual(["2026-01-02", "2026-01-01", "2025-12-31"]);
  });
});

describe("sumWeek", () => {
  it("adds every figure in cents, so ten cents three times is exactly thirty", () => {
    const t = sumWeek([
      summary({ sales: { count: 1, total: 0.1 } }),
      summary({ sales: { count: 1, total: 0.1 } }),
      summary({ sales: { count: 1, total: 0.1 } }),
    ]);
    expect(t.sales).toEqual({ count: 3, total: 0.3 });
  });
  it("sums money in, refunds by tender, store credit, on account and cash expected", () => {
    const t = sumWeek([summary(), summary()]);
    expect(t.moneyIn).toEqual({ cash: 20.2, card: 10, check: 0, other: 0, total: 30.2 });
    expect(t.refunds).toMatchObject({
      count: 2,
      cash: 4.4,
      card: 0,
      check: 0,
      other: 0,
      total: 4.4,
    });
    expect(t.storeCreditUsed).toBe(2);
    expect(t.onAccount).toBe(8);
    expect(t.storeCreditIssued).toEqual({ count: 0, amount: 0 });
    expect(t.cashExpectedInDrawer).toBe(15.8);
    expect(t.netCollected).toBe(25.8);
  });
  it("the tender is only known for the week when it is known for every day", () => {
    expect(sumWeek([summary(), summary()]).refunds.tenderKnown).toBe(true);
    expect(
      sumWeek([
        summary(),
        summary({
          refunds: { count: 1, cash: 0, card: 0, check: 0, other: 1, total: 1, tenderKnown: false },
        }),
      ]).refunds.tenderKnown,
    ).toBe(false);
  });
  it("an empty list sums to zeros", () => {
    const t = sumWeek([]);
    expect(t.sales).toEqual({ count: 0, total: 0 });
    expect(t.refunds.tenderKnown).toBe(true);
  });
});

describe("weekCsv", () => {
  const days = [
    { day: "2026-10-09", summary: summary() },
    { day: "2026-10-08", summary: summary({ sales: { count: 0, total: 0 } }) },
  ];
  it("has a header, one row per day (oldest first) and a Total row", () => {
    const lines = weekCsv(days).trim().split("\r\n");
    expect(lines[0]).toBe(
      "Day,Sales,Sales total,Cash in,Card in,Check in,Other in,Money in,Store credit used,On account,Refunds,Cash refunds,Card refunds,Check refunds,Other refunds,Store credit issued,Cash expected,Net collected",
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]!.startsWith("2026-10-08,0,0.00,")).toBe(true);
    expect(
      lines[2]!.startsWith("2026-10-09,2,20.10,10.10,5.00,0.00,0.00,15.10,1.00,4.00,2.20,"),
    ).toBe(true);
    expect(lines[3]!.startsWith("Total,2,20.10,")).toBe(true);
  });
  it("money has two decimals, no currency symbol or thousands comma (a spreadsheet can sum it)", () => {
    const csv = weekCsv([
      { day: "2026-10-09", summary: summary({ sales: { count: 1, total: 1234.5 } }) },
    ]);
    expect(csv).toContain(",1234.50,");
    expect(csv).not.toContain("$");
  });
  it("marks a week with refunds that lack a recorded tender, so the cash figure is not trusted silently", () => {
    const csv = weekCsv([
      {
        day: "2026-10-09",
        summary: summary({
          refunds: { count: 1, cash: 0, card: 0, check: 0, other: 1, total: 1, tenderKnown: false },
        }),
      },
    ]);
    expect(csv.trim().split("\r\n").pop()).toMatch(/refund method not recorded/);
  });
});
