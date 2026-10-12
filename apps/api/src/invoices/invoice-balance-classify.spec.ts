/**
 * SA-770 r-note: ONE TS classifier for "what is still owed, and is it overdue". It replaces the inline
 * copies in invoice-detail-read, the list enrichment (findAll), the KPI tiles and the two buyer readers.
 * The SQL predicate (`balanceDueSql`) is pinned against it row for row by
 * invoice-balance-sql.parity.db.spec.ts.
 */
import { InvoiceStatus } from "@prisma/client";
import { overdueCutoff } from "../common/calendar-date";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import {
  classifyInvoiceBalance,
  confirmedBalance,
  signedBalance,
  summarizeOpenInvoices,
} from "./invoice-balance-classify";

const pay = (amount: number, status = "PAID", method = "CASH") => ({ amount, status, method });
const inv = (
  total: number,
  payments: any[] = [],
  dueDate: Date | string | null = "2020-01-01T00:00:00.000Z",
  status = "SENT",
) => ({ status, total, dueDate, payments });
// the tenant's "today" is 2026-10-02: the UTC-midnight stamp the cutoff is
const CUTOFF = new Date("2026-10-02T00:00:00.000Z");

describe("confirmedBalance — total minus CONFIRMED payments, floored at zero, in cents", () => {
  it.each([
    ["unpaid", 100, [], 100],
    ["partial: $100 with $60 paid", 100, [pay(60)], 40],
    ["exactly paid", 100, [pay(100)], 0],
    ["overpaid is 0, never negative", 100, [pay(110)], 0],
    ["a DRAFT payment does not reduce it", 100, [pay(100, "DRAFT")], 100],
    ["a VOID payment does not reduce it", 100, [pay(100, "VOID")], 100],
    ["a PENDING check does not reduce it", 100, [pay(100, "PENDING")], 100],
    ["a credit-note application reduces it", 100, [pay(40, "PAID", "CREDIT_NOTE")], 60],
    ["an advance application reduces it", 100, [pay(25, "PAID", "ADVANCE")], 75],
    ["float dust is rounded away", 0.3, [pay(0.1), pay(0.2)], 0],
    ["one cent left", 100, [pay(99.99)], 0.01],
  ])("%s", (_l, total, payments, want) => {
    expect(confirmedBalance(total, payments)).toBe(want);
  });

  it("tolerates a missing payments relation", () => {
    expect(confirmedBalance(50, undefined)).toBe(50);
    expect(confirmedBalance("50.00", null)).toBe(50);
  });
});

describe("signedBalance — owner ruling 2026-10-11: the Receivable Summary's unclamped balance", () => {
  it.each([
    ["unpaid", 100, [], 100],
    ["partial", 100, [pay(60)], 40],
    ["exactly paid", 100, [pay(100)], 0],
    ["overpaid by $10 is -10, not 0", 100, [pay(110)], -10],
    [
      "a VOID / DRAFT / PENDING payment never counts",
      100,
      [pay(100, "VOID"), pay(5, "DRAFT")],
      100,
    ],
    ["a credit-note application counts like cash", 100, [pay(110, "PAID", "CREDIT_NOTE")], -10],
    [
      "11 x $0.10 against $1.10 is 0 (cents first), not 2e-16",
      1.1,
      Array.from({ length: 11 }, () => pay(0.1)),
      0,
    ],
  ])("%s", (_l, total, payments, want) => {
    const got = signedBalance(total, payments);
    expect(got).toBe(want);
    expect(Object.is(got, -0)).toBe(false);
  });

  it("a sub-cent negative residue is +0, never -0 (0.3 - 0.30000000000000004 = -5.5e-17)", () => {
    const got = signedBalance(0.3, [pay(0.1), pay(0.2)]);
    expect(Object.is(got, 0)).toBe(true);
  });

  it("agrees with confirmedBalance wherever the balance is not negative", () => {
    for (const p of [[], [pay(40)], [pay(100)], [pay(99.99)]]) {
      expect(signedBalance(100, p)).toBe(confirmedBalance(100, p));
    }
    expect(confirmedBalance(100, [pay(110)])).toBe(0); // the clamp stays the default everywhere else
  });
});

describe("classifyInvoiceBalance — balanceDue + isOverdue against a cutoff", () => {
  it("an overpaid open invoice past due: balance 0 and NOT overdue", () => {
    expect(classifyInvoiceBalance(inv(100, [pay(110)]), CUTOFF)).toEqual({
      balanceDue: 0,
      isOverdue: false,
    });
  });

  it("an exactly-paid open invoice past due is not overdue", () => {
    expect(classifyInvoiceBalance(inv(100, [pay(100)]), CUTOFF).isOverdue).toBe(false);
  });

  it("$100 with $60 paid, past due: balance $40 and overdue", () => {
    expect(classifyInvoiceBalance(inv(100, [pay(60)], "2026-09-01T00:00:00.000Z"), CUTOFF)).toEqual(
      {
        balanceDue: 40,
        isOverdue: true,
      },
    );
  });

  it("RF-202: due today (inside the tenant's due day) is NOT overdue; yesterday is", () => {
    expect(classifyInvoiceBalance(inv(100, [], "2026-10-02T00:00:00.000Z"), CUTOFF).isOverdue).toBe(
      false,
    );
    expect(classifyInvoiceBalance(inv(100, [], "2026-10-01T00:00:00.000Z"), CUTOFF).isOverdue).toBe(
      true,
    );
    // a due date with a time of day is still judged by its calendar day
    expect(classifyInvoiceBalance(inv(100, [], "2026-10-02T15:00:00.000Z"), CUTOFF).isOverdue).toBe(
      false,
    );
  });

  it("no due date is never overdue, and a Date instance works like a string", () => {
    expect(classifyInvoiceBalance(inv(100, [], null), CUTOFF).isOverdue).toBe(false);
    expect(classifyInvoiceBalance(inv(100, [], new Date("2026-09-30")), CUTOFF).isOverdue).toBe(
      true,
    );
  });

  it.each(["PAID", "VOID", "WRITTEN_OFF"])(
    "a %s invoice reads as settled: balance 0, never overdue, whatever its payments say",
    (status) => {
      expect(classifyInvoiceBalance(inv(100, [], "2020-01-01", status), CUTOFF)).toEqual({
        balanceDue: 0,
        isOverdue: false,
      });
    },
  );

  it("two sellers in different zones: the SAME due date is judged on each cutoff", () => {
    // 14:00Z on Oct 1 is 09:00 Oct 1 in Chicago and 03:00 Oct 2 in Auckland.
    const now = new Date("2026-10-01T14:00:00.000Z");
    const chicago = overdueCutoff(now, "America/Chicago");
    const auckland = overdueCutoff(now, "Pacific/Auckland");
    expect(chicago.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(auckland.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    const dueOct1 = inv(100, [], "2026-10-01T00:00:00.000Z");
    expect(classifyInvoiceBalance(dueOct1, chicago).isOverdue).toBe(false); // still its grace day
    expect(classifyInvoiceBalance(dueOct1, auckland).isOverdue).toBe(true); // the day has ended there
  });
});

/**
 * Row 318b: overdue is a property of an ISSUED, unpaid invoice. The classifier treated only PAID / VOID /
 * WRITTEN_OFF as not overdue, so a past-due DRAFT with a balance read isOverdue:true in the list enrichment
 * and the detail DTO while the KPI tiles and the list filter (OPEN_INVOICE_STATUSES) excluded DRAFT.
 */
describe("classifyInvoiceBalance - only an issued (open-status) invoice can be overdue (row 318b)", () => {
  it("a past-due DRAFT with a balance is NOT overdue, and keeps its balanceDue", () => {
    expect(classifyInvoiceBalance(inv(100, [], "2020-01-01", "DRAFT"), CUTOFF)).toEqual({
      balanceDue: 100,
      isOverdue: false,
    });
  });

  it.each(Object.values(InvoiceStatus))(
    "%s past due with a balance is overdue iff it is an open status",
    (status) => {
      const { isOverdue } = classifyInvoiceBalance(inv(100, [], "2020-01-01", status), CUTOFF);
      expect(isOverdue).toBe((OPEN_INVOICE_STATUSES as readonly string[]).includes(status));
    },
  );
});

describe("summarizeOpenInvoices — the buyer receivables figures", () => {
  const rows = [
    inv(100, [pay(110)]), // overpaid, past due
    inv(100, [pay(100)]), // exactly paid, still SENT
    inv(100, [pay(60)], "2026-09-01T00:00:00.000Z", "PARTIAL"), // $40 overdue
    inv(50, [], "2026-09-01T00:00:00.000Z", "OVERDUE"), // $50 overdue
    inv(200, [pay(20)], "2026-10-02T00:00:00.000Z"), // due today: $180 unpaid, not overdue
    inv(75, [], "2026-12-01T00:00:00.000Z", "VIEWED"), // $75 unpaid
    inv(10, [pay(10)], "2020-01-01", "PAID"), // paid
    inv(10, [], "2020-01-01", "DRAFT"), // not issued: not counted
    inv(10, [], "2020-01-01", "VOID"), // not counted
  ];

  it("counts only what is owed: overdue 2 ($90), unpaid 2, settled 3; the total is BALANCE, not gross", () => {
    expect(summarizeOpenInvoices(rows, CUTOFF)).toEqual({
      settledCount: 3, // overpaid + exactly paid (paid in substance) + PAID
      unpaidCount: 2,
      overdueCount: 2,
      unpaidTotal: 345, // 40 + 50 + 180 + 75, never 100+100+100+50+200+75
    });
  });

  it("an overpaid past-due invoice alone: overdue 0 and $0", () => {
    expect(summarizeOpenInvoices([inv(100, [pay(110)])], CUTOFF)).toMatchObject({
      overdueCount: 0,
      unpaidCount: 0,
      unpaidTotal: 0,
    });
  });

  it("sums in cents", () => {
    expect(summarizeOpenInvoices([inv(0.1), inv(0.2)], CUTOFF).unpaidTotal).toBe(0.3);
  });
});
