import { CounterSaleTodayService } from "./counter-sale-today.service";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import {
  creditNotesInWindowWhere,
  pageQuery,
  toTodaysSaleRow,
  windowReturnsWhere,
  type TodayOrderRecord,
} from "./counter-sale-today";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * Today's sales: WHEN a return was resolved.
 *  (a) a refund chosen at capture but not recorded yet (EXTERNAL_REFUND, `refundedAt` null) reads PENDING on the till, never
 *      REFUND, and counts in no day's refunds;
 *  (b) store credit is dated by when its CREDIT NOTE was created (the moment the credit was issued), not by when the return
 *      was captured: "Give store credit instead" on a pending refund mints the credit later than the capture.
 * Placeholders only (acme); no live-client data.
 */
const T = "test-tenant";
const at = (s: string) => new Date(s);
// New York, EDT (UTC-4). Day 1 = 2026-10-07, day 2 = 2026-10-08.
const NOW = at("2026-10-08T20:00:00.000Z");
const DAY1 = { start: at("2026-10-07T04:00:00.000Z"), end: at("2026-10-08T04:00:00.000Z") };

type Ret = TodayOrderRecord["returns"][number];
const ret = (over: Partial<Ret> = {}): Ret => ({
  id: "r-1",
  returnNumber: "RET-1",
  status: "RECEIVED",
  refundMethod: "EXTERNAL_REFUND",
  refundedAt: null,
  creditNoteId: null,
  refundAmount: null,
  creditSubtotal: "5.00",
  creditTax: "0.50",
  creditCategoryTax: "0.00",
  ...over,
});
const order = (returns: Ret[]): TodayOrderRecord => ({
  id: "o-1",
  orderNumber: "1042",
  status: "DELIVERED",
  total: "24.50",
  createdAt: at("2026-10-07T18:14:00.000Z"),
  customerId: "c-1",
  customer: { businessName: "Acme Test Customer", isWalkIn: false },
  invoices: [],
  returns,
});
const resolutions = (returns: Ret[]) =>
  toTodaysSaleRow(order(returns)).returned.returns.map((r) => r.resolution);

describe("(a) a refund that is not recorded yet reads PENDING", () => {
  it("EXTERNAL_REFUND with refundedAt null is PENDING and the sale's return state is PENDING", () => {
    const row = toTodaysSaleRow(order([ret()]));
    expect(row.returned.returns[0].resolution).toBe("PENDING");
    expect(row.returned.state).toBe("PENDING");
  });

  it("the same refund once recorded (refundedAt set) is REFUND, and the state is no longer PENDING", () => {
    const row = toTodaysSaleRow(
      order([ret({ status: "REFUNDED", refundedAt: at("2026-10-07T19:00:00.000Z") })]),
    );
    expect(row.returned.returns[0].resolution).toBe("REFUND");
    expect(row.returned.state).not.toBe("PENDING");
  });

  it("only a stored null is pending: a hand-built record without the field keeps reading REFUND", () => {
    const legacy = ret({ status: "REFUNDED" });
    delete legacy.refundedAt;
    expect(resolutions([legacy])).toEqual(["REFUND"]);
  });

  it("a credit note return with refundedAt null is not a pending refund", () => {
    expect(
      resolutions([
        ret({ status: "PROCESSED", refundMethod: "CREDIT_NOTE", creditNoteId: "cn-1" }),
      ]),
    ).toEqual(["STORE_CREDIT"]);
  });

  it("the page query selects refundedAt (without it every refund would read as recorded)", () => {
    const q = pageQuery(T, DAY1, 1, 50);
    expect(q.select.returns.select.refundedAt).toBe(true);
  });
});

describe("(b) store credit is windowed by its credit note's createdAt", () => {
  it("creditNotesInWindowWhere: the tenant's notes created in the window, VOID excluded", () => {
    expect(creditNotesInWindowWhere(T, DAY1)).toEqual({
      tenantId: T,
      status: { not: "VOID" },
      createdAt: { gte: DAY1.start, lt: DAY1.end },
    });
  });

  it("windowReturnsWhere: a credit-note return is matched by its note id, never by the return's createdAt", () => {
    const { OR } = windowReturnsWhere(T, DAY1, ["cn-1", "cn-2"]);
    expect(OR).toContainEqual({
      refundMethod: "CREDIT_NOTE",
      creditNoteId: { in: ["cn-1", "cn-2"] },
    });
    // the only createdAt branch left is the legacy one: a store-credit return with NO credit note id
    const byCreatedAt = OR.filter((c: any) => c.createdAt !== undefined);
    expect(byCreatedAt).toEqual([
      {
        refundMethod: "CREDIT_NOTE",
        creditNoteId: null,
        createdAt: { gte: DAY1.start, lt: DAY1.end },
      },
    ]);
  });

  it("windowReturnsWhere with no credit notes in the window has no `in` branch (and keeps the refund term)", () => {
    const { OR } = windowReturnsWhere(T, DAY1);
    expect(OR.some((c: any) => c.creditNoteId?.in !== undefined)).toBe(false);
    expect(OR).toContainEqual({
      refundMethod: "EXTERNAL_REFUND",
      refundedAt: { gte: DAY1.start, lt: DAY1.end },
    });
  });
});

// ─── the service, end to end over a stand-in that EVALUATES the where it is sent ───────────────

function m(rec: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => m(rec, w));
    const val = rec?.[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const ops = ["gte", "lt", "not", "notIn", "in"];
      if (Object.keys(v).every((x) => ops.includes(x))) {
        return (
          (v.gte === undefined || val >= v.gte) &&
          (v.lt === undefined || val < v.lt) &&
          (v.not === undefined || val !== v.not) &&
          (v.notIn === undefined || !v.notIn.includes(val)) &&
          (v.in === undefined || v.in.includes(val))
        );
      }
      return m(val, v);
    }
    if (val === undefined) throw new Error(`the stand-in does not model the field ${k}`);
    return val === v;
  });
}

const stored = (over: Record<string, unknown>) => ({
  tenantId: T,
  order: { tenantId: T, counterSale: true },
  status: "PROCESSED",
  refundMethod: null as string | null,
  refundedAt: null as Date | null,
  creditNoteId: null as string | null,
  refundAmount: null as string | null,
  creditSubtotal: null as string | null,
  creditTax: null as string | null,
  creditCategoryTax: null as string | null,
  createdAt: at("2026-10-07T16:00:00.000Z"),
  ...over,
});

function setup() {
  const prisma = createMockPrisma();
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
  const returns = [
    // captured on day 1 as a refund, then turned into store credit on day 2 (the note is minted on day 2)
    stored({
      id: "r-late-credit",
      creditNoteId: "cn-late",
      refundMethod: "CREDIT_NOTE",
      creditSubtotal: "5.00",
      creditTax: "0.50",
    }),
    // captured and credited on day 1, note minted on day 1
    stored({
      id: "r-day1-credit",
      creditNoteId: "cn-day1",
      refundMethod: "CREDIT_NOTE",
      creditSubtotal: "2.00",
      creditTax: "0.00",
    }),
    // its credit note was voided: no credit was issued
    stored({
      id: "r-void-note",
      creditNoteId: "cn-void",
      refundMethod: "CREDIT_NOTE",
      creditSubtotal: "9.00",
      creditTax: "0.00",
    }),
    // legacy: store credit with no credit note id keeps the day it was captured
    stored({ id: "r-legacy", refundMethod: "CREDIT_NOTE", refundAmount: "15.00" }),
    // a refund chosen on day 1 and not recorded yet: counts in no day
    stored({
      id: "r-pending-refund",
      status: "RECEIVED",
      refundMethod: "EXTERNAL_REFUND",
      creditSubtotal: "7.00",
      creditTax: "0.00",
    }),
    // a refund recorded on day 2
    stored({
      id: "r-refund-day2",
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: "4.00",
      refundedAt: at("2026-10-08T15:00:00.000Z"),
    }),
  ];
  const notes = [
    { id: "cn-late", tenantId: T, status: "ISSUED", createdAt: at("2026-10-08T15:00:00.000Z") },
    { id: "cn-day1", tenantId: T, status: "ISSUED", createdAt: at("2026-10-07T16:30:00.000Z") },
    { id: "cn-void", tenantId: T, status: "VOID", createdAt: at("2026-10-08T16:00:00.000Z") },
  ];
  prisma.return.findMany.mockImplementation(async (args: any) =>
    returns.filter((r) => m(r, args.where)),
  );
  prisma.creditNote.findMany.mockImplementation(async (args: any) =>
    notes.filter((n) => m(n, args.where)).map((n) => ({ id: n.id })),
  );
  const service = new CounterSaleTodayService(prisma as never);
  return (day: string) =>
    service.today({ page: 1, limit: 50, day } as CounterSaleTodayDto, NOW).then((r) => r.summary!);
}

describe("(b) the summary over two days", () => {
  it("day 1: only the credit issued on day 1 (and the legacy no-note return) counts; the credit minted on day 2 does not", async () => {
    const s = await setup()("2026-10-07");
    expect(s.storeCreditIssued).toEqual({ count: 2, amount: 17 }); // 2.00 + legacy 15.00
    expect(s.refunds.count).toBe(0); // a pending refund counts nowhere
    expect(s.refunds.total).toBe(0);
  });

  it("day 2: the credit minted on day 2 counts on day 2 even though the return was captured on day 1; a voided note does not", async () => {
    const s = await setup()("2026-10-08");
    expect(s.storeCreditIssued).toEqual({ count: 1, amount: 5.5 });
    expect(s.refunds.count).toBe(1);
    expect(s.refunds.total).toBe(4);
  });
});
