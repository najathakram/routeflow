// The issuer's number mint takes a billing-family advisory lock; there is no database here, so it is a
// pass-through (the issuer is only used for its pure windowsFor).
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import {
  assertActivationWindowNotEnded,
  assertWindowClearOfPaidInvoices,
  findRecentIdenticalActivation,
  resolveActivationWindow,
  voidCoveredRfInvoices,
} from "./rf-invoice-activation-void";
import { RfInvoiceIssuerService } from "./rf-invoice-issuer.service";

const TENANT = "tenant-1";
const ACTOR = "sa-1";
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date("2026-10-07T12:00:00.000Z");
const WINDOW_END = D("2026-11-06");

type Row = {
  id: string;
  tenantId: string;
  number: string;
  amount: number;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  periodKey: string | null;
  needsReview: boolean;
};
const row = (over: Partial<Row>): Row => ({
  id: "inv-1",
  tenantId: TENANT,
  number: "RF-2026-0001",
  amount: 149,
  status: "OPEN",
  periodStart: D("2026-10-10"),
  periodEnd: D("2026-11-03"),
  periodKey: D("2026-10-10").toISOString(),
  needsReview: false,
  ...over,
});

/** A tiny in-memory tx that honours the where clauses the helper sends. */
function fakeTx(rows: Row[]) {
  const cmp = (v: Date | null, f: any): boolean =>
    f === undefined ||
    (v !== null &&
      (f.gte === undefined || v >= f.gte) &&
      (f.lte === undefined || v <= f.lte) &&
      (f.gt === undefined || v > f.gt) &&
      (f.lt === undefined || v < f.lt));
  const matches = (r: Row, w: any): boolean =>
    (w.id === undefined || r.id === w.id) &&
    (w.tenantId === undefined || r.tenantId === w.tenantId) &&
    (w.status === undefined || r.status === w.status) &&
    (w.needsReview === undefined || r.needsReview === w.needsReview) &&
    cmp(r.periodStart, w.periodStart) &&
    cmp(r.periodEnd, w.periodEnd);
  const audits: any[] = [];
  const tx = {
    rfInvoice: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      findFirst: jest.fn(async ({ where }: any) => {
        const hit = rows
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.periodStart as Date).getTime() - (b.periodStart as Date).getTime());
        return hit[0] ?? null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          audits.find(
            (a) => a.action === where.action && a.meta?.dedupeKey === where.meta?.equals,
          ) ?? null,
      ),
    },
  };
  return tx;
}

const run = (tx: any) =>
  voidCoveredRfInvoices(tx, {
    tenantId: TENANT,
    windowStart: NOW,
    windowEnd: WINDOW_END,
    actorId: ACTOR,
    now: NOW,
  });

describe("voidCoveredRfInvoices (manual activation auto-void)", () => {
  it("voids an OPEN invoice the new prepaid window fully covers, with reason, audit and the periodKey KEPT", async () => {
    const rows = [row({})];
    const tx = fakeTx(rows);
    const out = await run(tx);
    expect(out).toEqual({ voided: ["inv-1"], flagged: [] });
    expect(rows[0]).toMatchObject({
      status: "VOID",
      voidedAt: NOW,
      voidReason: "Covered by manual activation on 2026-10-07",
      // an activation void is "settled outside, period consumed": the key is NOT renamed (the admin void's
      // "<iso>:void:<id>" rename releases the period; this must not), so the unique holds the slot
      periodKey: D("2026-10-10").toISOString(),
    });
    expect(tx.rfInvoice.updateMany.mock.calls[0][0].data).not.toHaveProperty("periodKey");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: TENANT,
      userId: ACTOR,
      action: AdminAuditAction.RF_INVOICE_VOIDED,
    });
    expect(data.meta).toMatchObject({
      invoiceId: "inv-1",
      number: "RF-2026-0001",
      trigger: "activation",
      reason: "Covered by manual activation on 2026-10-07",
    });
  });

  it("covers an invoice whose period exactly equals the window (half-open, both ends inclusive of equality)", async () => {
    const rows = [row({ periodStart: NOW, periodEnd: WINDOW_END })];
    expect((await run(fakeTx(rows))).voided).toEqual(["inv-1"]);
  });

  it("never touches a PAID or an already VOID invoice", async () => {
    const rows = [
      row({ id: "paid", status: "PAID" }),
      row({ id: "void", status: "VOID", periodKey: "k:void:void" }),
    ];
    const tx = fakeTx(rows);
    const out = await run(tx);
    expect(out.voided).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(["PAID", "VOID"]);
    expect(tx.rfInvoice.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("leaves a non-overlapping invoice OPEN", async () => {
    const rows = [row({ periodStart: D("2026-12-01"), periodEnd: D("2026-12-31") })];
    const tx = fakeTx(rows);
    expect((await run(tx)).voided).toEqual([]);
    expect(rows[0].status).toBe("OPEN");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a PARTIAL overlap stays OPEN, is flagged needsReview, and raises exactly one claim-keyed notice", async () => {
    const rows = [
      row({ id: "tail", periodStart: D("2026-10-20"), periodEnd: D("2026-11-20") }),
      row({ id: "head", periodStart: D("2026-09-20"), periodEnd: D("2026-10-20") }),
    ];
    const tx = fakeTx(rows);
    const out = await run(tx);
    expect(out.voided).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(["OPEN", "OPEN"]);
    expect(rows.map((r) => r.needsReview)).toEqual([true, true]);
    const notices = tx.auditLog.create.mock.calls
      .map((c: any) => c[0].data)
      .filter((d: any) => d.action === AdminAuditAction.RF_INVOICE_PARTLY_COVERED);
    expect(notices).toHaveLength(2); // one per invoice
    expect(notices[0].meta.message).toBe("Partly covered by manual activation on 2026-10-07");
    expect(notices[0].meta.dedupeKey).toContain("tail");
    // a rerun (a second activation touching the same rows) adds no second notice
    await run(tx);
    expect(
      tx.auditLog.create.mock.calls.filter(
        (c: any) => c[0].data.action === AdminAuditAction.RF_INVOICE_PARTLY_COVERED,
      ),
    ).toHaveLength(2);
  });

  it("ignores legacy rows with no period, and rows of another tenant", async () => {
    const rows = [
      row({ id: "legacy", periodStart: null, periodEnd: null, periodKey: null }),
      row({ id: "other", tenantId: "tenant-2" }),
    ];
    const tx = fakeTx(rows);
    expect((await run(tx)).voided).toEqual([]);
    expect(rows.every((r) => r.status === "OPEN")).toBe(true);
  });

  it("scopes the read and the CAS write by tenantId, and the write by OPEN status", async () => {
    const tx = fakeTx([row({})]);
    await run(tx);
    expect(tx.rfInvoice.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: TENANT,
      status: "OPEN",
    });
    expect(tx.rfInvoice.updateMany.mock.calls[0][0].where).toMatchObject({
      id: "inv-1",
      tenantId: TENANT,
      status: "OPEN",
    });
  });

  it("writes no audit row for an invoice that lost the CAS (count 0)", async () => {
    const tx = fakeTx([row({})]);
    tx.rfInvoice.updateMany.mockResolvedValue({ count: 0 });
    const out = await run(tx);
    expect(out.voided).toEqual([]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("activation window anchored on the earliest OPEN invoice (PR4a, owner ruling A)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const P = D("2026-11-01");
  const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
  const THREE_DAYS_BEFORE = plus(P, -3);
  const monthly = (over: Partial<Row> = {}) =>
    row({ periodStart: P, periodEnd: plus(P, 30), periodKey: P.toISOString(), ...over });

  /** What activateManualSubscription does inside its transaction: resolve the window, then void what it covers. */
  async function activate(rows: Row[], days: number, now: Date = THREE_DAYS_BEFORE) {
    const tx = fakeTx(rows);
    const w = await resolveActivationWindow(tx, { tenantId: TENANT, now, days });
    const out = await voidCoveredRfInvoices(tx, {
      tenantId: TENANT,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      actorId: ACTOR,
      now,
    });
    return { w, out, tx };
  }

  it("PIN 1: a monthly invoice [P, P+30d) and a 30-day activation at P-3d -> the invoice is VOID, the period ends P+30d, the next issue starts P+30d", async () => {
    const rows = [monthly()];
    const { w, out } = await activate(rows, 30);

    expect(w.windowStart).toEqual(P);
    expect(w.windowEnd).toEqual(plus(P, 30)); // the subscription period is written from this window
    expect(out).toEqual({ voided: ["inv-1"], flagged: [] });
    expect(rows[0].status).toBe("VOID");
    expect(rows[0].periodKey).toBe(P.toISOString()); // the voided row still holds the period's key

    // the issuer reads the subscription period the activation wrote: its next invoice starts where it ends
    const issuer = new (RfInvoiceIssuerService as any)(
      { rfInvoice: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) } },
      {},
      {},
    ) as RfInvoiceIssuerService;
    const next = await issuer.windowsFor(
      { tenantId: TENANT, periodStart: w.windowStart, periodEnd: w.windowEnd } as any,
      THREE_DAYS_BEFORE,
      Infinity,
    );
    expect(next).toHaveLength(1);
    // the issuer snaps every window start to the 12:00Z anchor (a legacy 00:00Z spelling is the same period)
    expect(next[0].periodStart).toEqual(new Date(plus(P, 30).getTime() + 12 * 60 * 60 * 1000));
  });

  it("PIN 2: a 14-day activation at P-3d only PARTLY covers the monthly invoice -> flagged needsReview, not voided", async () => {
    const rows = [monthly()];
    const { w, out } = await activate(rows, 14);

    expect(w.windowStart).toEqual(P);
    expect(w.windowEnd).toEqual(plus(P, 14));
    expect(out).toEqual({ voided: [], flagged: ["inv-1"] });
    expect(rows[0]).toMatchObject({ status: "OPEN", needsReview: true });
  });

  it("PIN 3: no OPEN invoice with a period (none at all, PAID, VOID, or period-less) -> windowStart is now", async () => {
    const none = await resolveActivationWindow(fakeTx([]), {
      tenantId: TENANT,
      now: NOW,
      days: 30,
    });
    expect(none.windowStart).toEqual(NOW);
    expect(none.windowEnd).toEqual(plus(NOW, 30));

    const rows = [
      monthly({ id: "paid", status: "PAID" }),
      monthly({ id: "void", status: "VOID" }),
      row({ id: "legacy", periodStart: null, periodEnd: null, periodKey: null }),
      monthly({ id: "other", tenantId: "tenant-2" }),
    ];
    const w = await resolveActivationWindow(fakeTx(rows), { tenantId: TENANT, now: NOW, days: 14 });
    expect(w.windowStart).toEqual(NOW);
    expect(w.windowEnd).toEqual(plus(NOW, 14));
  });

  it("anchors on the EARLIEST open invoice, whichever order the rows come in", async () => {
    const rows = [
      monthly({ id: "later", periodStart: plus(P, 30), periodEnd: plus(P, 60), periodKey: "k2" }),
      monthly({ id: "earliest" }),
    ];
    const { w, out } = await activate(rows, 60);
    expect(w.windowStart).toEqual(P);
    expect(w.windowEnd).toEqual(plus(P, 60));
    expect(out.voided.sort()).toEqual(["earliest", "later"]);
  });

  it("lock order: every admin-alert advisory lock is taken BEFORE the first RfInvoice write", async () => {
    // 'a' is fully covered (a void write); 'b' and 'c' are partly covered (flag writes + a notice each).
    const rows = [
      row({ id: "a", periodStart: NOW, periodEnd: plus(NOW, 5), periodKey: "ka" }),
      row({ id: "c", periodStart: plus(NOW, 20), periodEnd: plus(NOW, 50), periodKey: "kc" }),
      row({ id: "b", periodStart: plus(NOW, 25), periodEnd: plus(NOW, 55), periodKey: "kb" }),
    ];
    const tx = fakeTx(rows);
    await voidCoveredRfInvoices(tx, {
      tenantId: TENANT,
      windowStart: NOW,
      windowEnd: plus(NOW, 30),
      actorId: ACTOR,
      now: NOW,
    });
    const locks = tx.$executeRaw.mock.invocationCallOrder;
    const writes = tx.rfInvoice.updateMany.mock.invocationCallOrder;
    expect(locks).toHaveLength(2); // one per partly covered invoice
    expect(Math.max(...locks)).toBeLessThan(Math.min(...writes));
    expect(rows.map((r) => r.status)).toEqual(["VOID", "OPEN", "OPEN"]);
  });
});

describe("an activation void keeps the period consumed (the issuer's catch-up must not re-bill it)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const P = D("2026-11-01");
  const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

  const SNAPPED_P = new Date(P.getTime() + 12 * 60 * 60 * 1000).toISOString();

  it("PIN 4: PAID [P-30d, P) + OPEN [P, P+30d), activated at P-3d for 30 days -> the issuer's catch-up window for [P, P+30d) is 'exists', nothing is built", async () => {
    const now = plus(P, -3);
    const rows = [
      row({
        id: "paid",
        status: "PAID",
        periodStart: plus(P, -30),
        periodEnd: P,
        periodKey: plus(P, -30).toISOString(),
      }),
      // an issued row carries the SNAPPED (12:00Z) key, as the issuer writes it
      row({ id: "open", periodStart: P, periodEnd: plus(P, 30), periodKey: SNAPPED_P }),
    ];
    const tx = fakeTx(rows);
    const w = await resolveActivationWindow(tx, { tenantId: TENANT, now, days: 30 });
    await voidCoveredRfInvoices(tx, {
      tenantId: TENANT,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      actorId: ACTOR,
      now,
    });
    expect(rows[1]).toMatchObject({ status: "VOID", periodKey: SNAPPED_P });

    // the issuer over the same rows: findFirst honours tenantId / periodKey / periodEnd / status {not}
    const findFirst = jest.fn(async ({ where }: any) => {
      const hit = rows.find(
        (r) =>
          r.tenantId === where.tenantId &&
          (where.periodKey === undefined || r.periodKey === where.periodKey) &&
          (where.periodEnd === undefined ||
            (r.periodEnd as Date).getTime() === where.periodEnd.getTime()) &&
          (where.status?.not === undefined || r.status !== where.status.not),
      );
      return hit ? { id: hit.id } : null;
    });
    // the issuer's two range reads (a prior invoice ending / one starting near the window), over the same rows
    const findMany = jest.fn(async ({ where }: any) =>
      rows.filter((r) => {
        const inRange = (v: Date | null, f: any) =>
          f === undefined || (v !== null && v >= f.gte && v <= f.lte);
        return (
          r.tenantId === where.tenantId &&
          (where.status?.not === undefined || r.status !== where.status.not) &&
          inRange(r.periodEnd, where.periodEnd) &&
          inRange(r.periodStart, where.periodStart)
        );
      }),
    );
    const build = jest.fn();
    const issuer = new (RfInvoiceIssuerService as any)(
      { rfInvoice: { findFirst, findMany } },
      { build },
      {},
    ) as RfInvoiceIssuerService;
    const sub = {
      tenantId: TENANT,
      cycle: "MONTHLY",
      periodStart: w.windowStart,
      periodEnd: w.windowEnd,
    };

    const windows = await issuer.windowsFor(sub as any, now);
    // the PAID prior row ends at P, so the catch-up branch proposes [P, P+30d) again ...
    expect(windows).toEqual([{ periodStart: P, periodEnd: plus(P, 30) }]);
    // ... and the voided row's kept key makes it 'exists': no draft is built, no invoice is created
    expect(await issuer.issuePeriod(sub as any, windows[0], now)).toEqual({ status: "exists" });
    expect(build).not.toHaveBeenCalled();
  });
});

describe("assertActivationWindowNotEnded (owner ruling: an ended window is refused, never clamped)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MESSAGE =
    "Invoice RF-2026-0001 (2026-09-01 to 2026-10-01) is still open and this payment's window ended on 2026-10-01. Mark it paid or void it in RouteFlow invoices, or activate for at least 37 days.";
  const BLOCKING = {
    number: "RF-2026-0001",
    periodStart: D("2026-09-01"),
    periodEnd: D("2026-10-01"),
  };
  const ended = (over: { windowEnd?: Date; blocking?: typeof BLOCKING | null } = {}) => ({
    windowStart: D("2026-09-01"),
    windowEnd: D("2026-10-01"),
    blocking: BLOCKING as typeof BLOCKING | null,
    ...over,
  });

  const refusal = (fn: () => void): ConflictException => {
    try {
      fn();
    } catch (e) {
      return e as ConflictException;
    }
    throw new Error("expected the activation window to be refused");
  };

  it("windowEnd <= now -> 409 ACTIVATION_PERIOD_ALREADY_ENDED naming the blocking invoice and the real fixes", () => {
    const err = refusal(() => assertActivationWindowNotEnded(ended(), NOW));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED,
      message: MESSAGE,
      invoiceNumber: "RF-2026-0001",
      endedOn: "2026-10-01",
      minDays: 37,
    });
  });

  it("minDays also covers the blocking invoice's whole period when that runs past the window", () => {
    // OPEN [now-40d, now+20d), a 30-day activation ends 10 days ago: 41 days reach now, 60 cover the invoice.
    const start = new Date(NOW.getTime() - 40 * DAY_MS);
    const err = refusal(() =>
      assertActivationWindowNotEnded(
        {
          windowStart: start,
          windowEnd: new Date(start.getTime() + 30 * DAY_MS),
          blocking: {
            number: "RF-2026-0007",
            periodStart: start,
            periodEnd: new Date(start.getTime() + 60 * DAY_MS),
          },
        },
        NOW,
      ),
    );
    expect(err.getResponse()).toMatchObject({ invoiceNumber: "RF-2026-0007", minDays: 60 });
  });

  it("with no blocking invoice (never reached in practice) it still refuses with a plain message and endedOn/minDays", () => {
    const err = refusal(() => assertActivationWindowNotEnded(ended({ blocking: null }), NOW));
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe(API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED);
    expect(body).not.toHaveProperty("invoiceNumber");
    expect(body).toMatchObject({ endedOn: "2026-10-01", minDays: 37 });
    expect(body.message).toContain("2026-10-01");
  });

  it("windowEnd exactly equal to now is refused; one millisecond later is allowed", () => {
    expect(() => assertActivationWindowNotEnded(ended({ windowEnd: NOW }), NOW)).toThrow(
      ConflictException,
    );
    expect(() =>
      assertActivationWindowNotEnded(ended({ windowEnd: new Date(NOW.getTime() + 1) }), NOW),
    ).not.toThrow();
  });

  it("an OPEN invoice 40 days back anchors a 30-day window that ended 10 days ago -> refused, not clamped", async () => {
    const rows = [
      row({
        periodStart: new Date(NOW.getTime() - 40 * DAY_MS),
        periodEnd: new Date(NOW.getTime() - 10 * DAY_MS),
      }),
    ];
    const w = await resolveActivationWindow(fakeTx(rows), { tenantId: TENANT, now: NOW, days: 30 });
    expect(w.windowEnd.getTime()).toBe(NOW.getTime() - 10 * DAY_MS); // the window is resolved unclamped ...
    expect(w.blocking).toMatchObject({ number: "RF-2026-0001" }); // ... the oldest OPEN invoice is the blocker
    expect(() => assertActivationWindowNotEnded(w, NOW)).toThrow(ConflictException); // ... then refused
  });
});

describe("assertWindowClearOfPaidInvoices (SA M2: OPEN Aug, PAID Sep, OPEN Oct must not take September twice)", () => {
  const aug = row({
    id: "aug",
    number: "RF-AUG",
    periodStart: D("2026-08-01"),
    periodEnd: D("2026-09-01"),
  });
  const sep = row({
    id: "sep",
    number: "RF-SEP",
    status: "PAID",
    periodStart: D("2026-09-01"),
    periodEnd: D("2026-10-01"),
  });
  const oct = row({
    id: "oct",
    number: "RF-OCT",
    periodStart: D("2026-10-01"),
    periodEnd: D("2026-11-01"),
  });
  const now = D("2026-10-07");

  async function run(rows: Row[], days: number) {
    const tx = fakeTx(rows);
    const w = await resolveActivationWindow(tx, { tenantId: TENANT, now, days });
    return assertWindowClearOfPaidInvoices(tx, { tenantId: TENANT, window: w }).then(
      () => null,
      (e) => e as ConflictException,
    );
  }

  it("a 90-day window from Aug 1 runs over the PAID September invoice -> 409 naming it, with the longest safe length", async () => {
    const err = await run([aug, sep, oct], 90);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ACTIVATION_OVERLAPS_PAID_PERIOD,
      invoiceNumber: "RF-SEP",
      paidFrom: "2026-09-01",
      maxDays: 31,
    });
  });

  it("a window that stops at the paid period's start is allowed (31 days from Aug 1 ends Sep 1)", async () => {
    expect(await run([aug, sep, oct], 31)).toBeNull();
  });

  it("a paid period covering the window start leaves maxDays 0", async () => {
    const paidFirst = row({
      id: "p0",
      number: "RF-JUL",
      status: "PAID",
      periodStart: D("2026-07-15"),
      periodEnd: D("2026-08-15"),
    });
    const err = await run([paidFirst, aug], 30);
    expect(err?.getResponse()).toMatchObject({ invoiceNumber: "RF-JUL", maxDays: 0 });
  });

  it("with NO open invoice the window starts now exactly as it always did: a paid current period never refuses", async () => {
    const paidNow = row({
      id: "p1",
      status: "PAID",
      periodStart: D("2026-10-01"),
      periodEnd: D("2026-11-01"),
    });
    expect(await run([paidNow], 30)).toBeNull();
  });
});

describe("findRecentIdenticalActivation (SA M3: a double-click records one period and one marker)", () => {
  const now = D("2026-10-07");
  const KEY = {
    tenantId: TENANT,
    now,
    plan: "STARTER",
    paymentMethod: "CHEQUE",
    paymentRef: "CHQ-1",
    days: 30,
  };
  const meta = {
    plan: "STARTER",
    paymentMethod: "CHEQUE",
    paymentRef: "CHQ-1",
    billingPeriodDays: 30,
    periodStart: "2026-09-12T00:00:00.000Z",
    periodEnd: "2026-10-12T00:00:00.000Z",
  };
  const txWith = (row: { meta: Record<string, unknown> } | null) => ({
    auditLog: { findFirst: jest.fn(async () => row) },
  });

  it("the same plan, method, reference and length inside the repeat window is the first activation's period", async () => {
    const tx = txWith({ meta });
    expect(await findRecentIdenticalActivation(tx, KEY)).toEqual({
      periodStart: new Date("2026-09-12T00:00:00.000Z"),
      periodEnd: new Date("2026-10-12T00:00:00.000Z"),
    });
    const where = (tx.auditLog.findFirst.mock.calls[0] as any[])[0].where;
    expect(where.action).toBe(AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER);
    expect(where.createdAt.gte.getTime()).toBe(now.getTime() - 2 * 60 * 1000);
  });

  it.each([
    ["plan", { plan: "GROWTH" }],
    ["payment method", { paymentMethod: "WIRE" }],
    ["reference", { paymentRef: "CHQ-2" }],
    ["length", { billingPeriodDays: 60 }],
  ])("a different %s is a new payment", async (_n, over) => {
    expect(
      await findRecentIdenticalActivation(txWith({ meta: { ...meta, ...over } }), KEY),
    ).toBeNull();
  });

  it("no recent marker, a marker from before the key existed, or a malformed one: not a repeat", async () => {
    expect(await findRecentIdenticalActivation(txWith(null), KEY)).toBeNull();
    const { billingPeriodDays: _omit, ...legacy } = meta;
    expect(await findRecentIdenticalActivation(txWith({ meta: legacy }), KEY)).toBeNull();
    expect(
      await findRecentIdenticalActivation(txWith({ meta: { ...meta, periodEnd: "junk" } }), KEY),
    ).toBeNull();
  });

  it("a null reference matches a null reference", async () => {
    const m = { ...meta, paymentRef: null };
    expect(
      await findRecentIdenticalActivation(txWith({ meta: m }), { ...KEY, paymentRef: null }),
    ).not.toBeNull();
  });
});
