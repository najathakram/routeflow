import { AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { voidCoveredRfInvoices } from "./rf-invoice-activation-void";

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
  ...over,
});

/** A tiny in-memory tx that honours the where clauses the helper sends. */
function fakeTx(rows: Row[]) {
  const matches = (r: Row, w: any): boolean =>
    (w.id === undefined || r.id === w.id) &&
    (w.tenantId === undefined || r.tenantId === w.tenantId) &&
    (w.status === undefined || r.status === w.status) &&
    (w.periodStart?.gte === undefined ||
      (r.periodStart !== null && r.periodStart >= w.periodStart.gte)) &&
    (w.periodEnd?.lte === undefined || (r.periodEnd !== null && r.periodEnd <= w.periodEnd.lte));
  const tx = {
    rfInvoice: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
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
  it("voids an OPEN invoice the new prepaid window fully covers, with reason, periodKey suffix and audit", async () => {
    const rows = [row({})];
    const tx = fakeTx(rows);
    const out = await run(tx);
    expect(out).toEqual({ voided: ["inv-1"] });
    expect(rows[0]).toMatchObject({
      status: "VOID",
      voidedAt: NOW,
      voidReason: "Covered by manual activation on 2026-10-07",
      periodKey: `${D("2026-10-10").toISOString()}:void:inv-1`,
    });
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

  it("leaves a PARTIAL overlap OPEN (ends after the window, or starts before it)", async () => {
    const rows = [
      row({ id: "tail", periodStart: D("2026-10-20"), periodEnd: D("2026-11-20") }),
      row({ id: "head", periodStart: D("2026-09-20"), periodEnd: D("2026-10-20") }),
    ];
    const tx = fakeTx(rows);
    expect((await run(tx)).voided).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(["OPEN", "OPEN"]);
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
