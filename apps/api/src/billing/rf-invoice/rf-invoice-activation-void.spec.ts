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
      { rfInvoice: { findFirst: jest.fn(async () => null) } },
      {},
      {},
    ) as RfInvoiceIssuerService;
    const next = await issuer.windowsFor(
      { tenantId: TENANT, periodStart: w.windowStart, periodEnd: w.windowEnd } as any,
      THREE_DAYS_BEFORE,
      Infinity,
    );
    expect(next).toHaveLength(1);
    expect(next[0].periodStart).toEqual(plus(P, 30));
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
      row({ id: "open", periodStart: P, periodEnd: plus(P, 30), periodKey: P.toISOString() }),
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
    expect(rows[1]).toMatchObject({ status: "VOID", periodKey: P.toISOString() });

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
    const build = jest.fn();
    const issuer = new (RfInvoiceIssuerService as any)(
      { rfInvoice: { findFirst } },
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
    "This payment covers an invoice period that already ended on 2026-10-01. Activate for more days to reach today, or record the newer invoices first.";

  const refusal = (fn: () => void): ConflictException => {
    try {
      fn();
    } catch (e) {
      return e as ConflictException;
    }
    throw new Error("expected the activation window to be refused");
  };

  it("windowEnd <= now -> 409 ACTIVATION_PERIOD_ALREADY_ENDED with the exact message", () => {
    const err = refusal(() => assertActivationWindowNotEnded({ windowEnd: D("2026-10-01") }, NOW));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED,
      message: MESSAGE,
    });
  });

  it("windowEnd exactly equal to now is refused; one millisecond later is allowed", () => {
    expect(() => assertActivationWindowNotEnded({ windowEnd: NOW }, NOW)).toThrow(
      ConflictException,
    );
    expect(() =>
      assertActivationWindowNotEnded({ windowEnd: new Date(NOW.getTime() + 1) }, NOW),
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
    expect(() => assertActivationWindowNotEnded(w, NOW)).toThrow(ConflictException); // ... then refused
  });
});
