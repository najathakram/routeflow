import { readFileSync } from "fs";
import { join } from "path";
import { InvoiceStatus, UserRole } from "@prisma/client";
import type { EditedLine } from "./invoice-edit-plan";
import type { IssuedEditCtx, LockedInvoiceForEdit } from "./locked-invoice-edit";
import { afterIssuedEditInTx, writeIfFigureFree } from "./issued-invoice-edit";

jest.mock("../regulated/filing-lock", () => ({
  assertSalesNotLockedForEdit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../orders/unit-aware-guard", () => ({
  assertInvoiceRewriteAllowed: jest.fn().mockResolvedValue(undefined),
}));

/**
 * SA-1508 commit 7 (epilogue). Red on master: `afterIssuedEditInTx` and the issued audit row do not exist (master edits
 * only a DRAFT, so an edit of a sent invoice writes no `invoice.revised` row, never re-judges the status and never
 * re-syncs the commission). One issued edit, in the caller's transaction, ends with: the status recomputed from the
 * confirmed payments and the NEW total and due date, the commission re-synced (a money edit only), and exactly ONE
 * `invoice.revised` row (a save that wrote nothing writes none). Fixtures are `acme` dummy data.
 */
const ADMIN = { sub: "u-admin", role: UserRole.TENANT_ADMIN } as any;
const FUTURE = new Date("2099-12-01T00:00:00Z");
const PAST = new Date("2020-01-01T00:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  productId: "p1",
  description: "Widget",
  notes: null,
  position: 0,
  qty: 2,
  boxes: null,
  pieces: null,
  unitPrice: 50,
  discount: 0,
  taxRate: 0,
  subtotal: 100,
  unitLabel: null,
  categoryTaxAmount: 0,
  orderItemId: null,
  ...over,
});
const cur = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  customerId: "c1",
  orderId: null,
  status: InvoiceStatus.SENT,
  discount: 0,
  shippingFee: 0,
  subtotal: 100,
  taxAmount: 0,
  total: 100,
  issueDate: new Date("2026-11-01T00:00:00Z"),
  dueDate: FUTURE,
  notes: null,
  depositPercent: null,
  depositDueDate: null,
  ...over,
});
const lockedOf = (inv = cur(), payments: any[] = []): LockedInvoiceForEdit => ({
  invoice: inv,
  storedRows: [row()],
  isTaxExempt: false,
  payments,
});
const ctx = (over: Partial<IssuedEditCtx> = {}): IssuedEditCtx => ({
  mode: "ISSUED",
  actor: ADMIN,
  tenantId: "t1",
  dto: {},
  due: { dueDate: null, depositDueDate: null },
  ...over,
});
/** What the save wrote: the row as the update returned it (with its lines). */
const afterOf = (over: Record<string, unknown> = {}) => ({
  ...cur(),
  updatedAt: new Date("2026-11-25T10:00:00Z"),
  items: [row()],
  ...over,
});
const fakeTx = (zone: string | null = null): any => ({
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  tenantConfig: { findUnique: jest.fn().mockResolvedValue(zone ? { timezone: zone } : null) },
  invoice: {
    update: jest.fn().mockImplementation(async (a: any) => ({
      ...afterOf(),
      updatedAt: new Date("2026-11-25T10:00:01Z"),
      ...a.data,
    })),
    findUnique: jest.fn().mockResolvedValue({ id: "inv-1", reread: true }),
  },
  invoiceItem: { update: jest.fn().mockResolvedValue({}) },
  buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
  creditNote: { count: jest.fn().mockResolvedValue(0) },
  returnItem: { count: jest.fn().mockResolvedValue(0) },
  order: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
});
const commission = () => ({ syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) });
const rows = (tx: any) => tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);

describe("afterIssuedEditInTx: the status", () => {
  it("a DRAFT is never touched: no read, no write, no row, no commission", async () => {
    const tx = fakeTx();
    const c = commission();
    const after = afterOf({ status: InvoiceStatus.DRAFT });
    const out = await afterIssuedEditInTx(
      { commissionEngine: c },
      tx,
      lockedOf(cur({ status: InvoiceStatus.DRAFT })),
      after,
      ctx({ mode: "DRAFT" }),
      { money: true },
    );
    expect(out).toBe(after);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(c.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  });

  it("a due date moved into the past flips SENT to OVERDUE, in the row and in the response", async () => {
    const tx = fakeTx();
    const after = afterOf({ dueDate: PAST });
    const out = await afterIssuedEditInTx({}, tx, lockedOf(), after, ctx(), { money: false });
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    expect(tx.invoice.update.mock.calls[0][0]).toMatchObject({
      where: { id: "inv-1" },
      data: { status: InvoiceStatus.OVERDUE },
    });
    expect(out.status).toBe(InvoiceStatus.OVERDUE);
    // the status write bumps updatedAt: the response carries the NEW token, not the one before the write
    expect(out.updatedAt).toEqual(new Date("2026-11-25T10:00:01Z"));
  });

  it("an OVERDUE invoice whose due date moved out is SENT again", async () => {
    const tx = fakeTx();
    const out = await afterIssuedEditInTx(
      {},
      tx,
      lockedOf(cur({ status: InvoiceStatus.OVERDUE, dueDate: PAST })),
      afterOf({ status: InvoiceStatus.OVERDUE, dueDate: FUTURE }),
      ctx(),
      { money: false },
    );
    expect(out.status).toBe(InvoiceStatus.SENT);
  });

  it("VIEWED becomes SENT (an edited document has not been seen in its new form)", async () => {
    const tx = fakeTx();
    const out = await afterIssuedEditInTx(
      {},
      tx,
      lockedOf(cur({ status: InvoiceStatus.VIEWED })),
      afterOf({ status: InvoiceStatus.VIEWED }),
      ctx(),
      { money: false },
    );
    expect(out.status).toBe(InvoiceStatus.SENT);
    expect(rows(tx)[0].meta).toMatchObject({ fromStatus: "VIEWED", toStatus: "SENT" });
  });

  it("the due day is judged in the tenant's zone, read inside the transaction", async () => {
    const tx = fakeTx("Pacific/Kiritimati");
    await afterIssuedEditInTx({}, tx, lockedOf(), afterOf(), ctx(), { money: false });
    expect(tx.tenantConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
  });

  it("an unchanged status writes no second update", async () => {
    const tx = fakeTx();
    await afterIssuedEditInTx({}, tx, lockedOf(), afterOf(), ctx(), { money: false });
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});

describe("afterIssuedEditInTx: commission", () => {
  it("a money edit re-syncs the commission once, in the same transaction, after the status", async () => {
    const tx = fakeTx();
    const c = commission();
    const order: string[] = [];
    tx.invoice.update.mockImplementation(async (a: any) => {
      order.push("status");
      return { id: "inv-1", ...a.data };
    });
    c.syncInvoiceCommissionSafe.mockImplementation(async () => void order.push("commission"));
    await afterIssuedEditInTx(
      { commissionEngine: c },
      tx,
      lockedOf(),
      afterOf({ dueDate: PAST }),
      ctx(),
      { money: true },
    );
    expect(c.syncInvoiceCommissionSafe).toHaveBeenCalledTimes(1);
    expect(c.syncInvoiceCommissionSafe).toHaveBeenCalledWith("inv-1", tx);
    expect(order).toEqual(["status", "commission"]);
  });

  it("a figure-free edit never touches the commission", async () => {
    const tx = fakeTx();
    const c = commission();
    await afterIssuedEditInTx({ commissionEngine: c }, tx, lockedOf(), afterOf(), ctx(), {
      money: false,
    });
    expect(c.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  });
});

describe("afterIssuedEditInTx: the audit row", () => {
  it("one invoice.revised row with the actor, the statuses, both totals, the line views and the lines changed", async () => {
    const tx = fakeTx();
    const after = afterOf({
      total: 150,
      subtotal: 150,
      discount: 5,
      notes: "gate 4",
      items: [row({ qty: 3, unitPrice: 50, subtotal: 150 })],
    });
    await afterIssuedEditInTx({ commissionEngine: commission() }, tx, lockedOf(), after, ctx(), {
      money: true,
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const [data] = rows(tx);
    expect(data).toMatchObject({
      userId: "u-admin",
      action: "invoice.revised",
      entityType: "invoice",
      entityId: "inv-1",
    });
    expect(data.meta).toMatchObject({
      source: "invoice-edit",
      actor: "u-admin",
      fromStatus: "SENT",
      toStatus: "SENT",
      totalBefore: 100,
      totalAfter: 150,
      linesChanged: 1,
      notesChanged: true,
      figureFree: false,
    });
    expect(data.meta.before).toEqual({
      lines: [
        {
          id: "r1",
          productId: "p1",
          qty: 2,
          boxes: null,
          pieces: null,
          unitPrice: 50,
          subtotal: 100,
        },
      ],
      discount: 0,
      shippingFee: 0,
      taxAmount: 0,
      dueDate: FUTURE.toISOString(),
    });
    expect(data.meta.after).toMatchObject({
      lines: [{ id: "r1", qty: 3, subtotal: 150 }],
      discount: 5,
      dueDate: FUTURE.toISOString(),
    });
    expect(data.meta).not.toHaveProperty("consented");
  });

  it("a figure-free row says so, and notesChanged is false when only the due date moved", async () => {
    const tx = fakeTx();
    await afterIssuedEditInTx({}, tx, lockedOf(), afterOf({ dueDate: PAST }), ctx(), {
      money: false,
    });
    expect(rows(tx)[0].meta).toMatchObject({
      figureFree: true,
      notesChanged: false,
      linesChanged: 0,
      toStatus: "OVERDUE",
    });
  });

  it("a consented edit records both totals, both taxes and consented: true", async () => {
    const tx = fakeTx();
    const edit = ctx({ consented: true });
    await afterIssuedEditInTx(
      { commissionEngine: commission() },
      tx,
      lockedOf(cur({ taxAmount: 24.75, total: 124.75 })),
      afterOf({ taxAmount: 8.25, total: 108.25 }),
      edit,
      { money: true },
    );
    expect(rows(tx)[0].meta).toMatchObject({
      consented: true,
      totalBefore: 124.75,
      totalAfter: 108.25,
      taxBefore: 24.75,
      taxAfter: 8.25,
    });
  });

  it("impersonatedBy is on the row only when the actor carries it, never an explicit null", async () => {
    const plain = fakeTx();
    await afterIssuedEditInTx({}, plain, lockedOf(), afterOf(), ctx(), { money: false });
    expect(rows(plain)[0]).not.toHaveProperty("impersonatedBy");

    const support = fakeTx();
    await afterIssuedEditInTx(
      {},
      support,
      lockedOf(),
      afterOf(),
      ctx({ actor: { ...ADMIN, impersonatedBy: "sa-9" } }),
      { money: false },
    );
    expect(rows(support)[0].impersonatedBy).toBe("sa-9");
  });
});

describe("one real issued edit, one epilogue, one row (the table)", () => {
  const items: EditedLine[] = [{ rowId: "r1", untouched: true, data: row() as any }];
  const bump = (): EditedLine[] => [
    { rowId: "r1", untouched: true, data: row({ description: "Widget (blue)" }) as any },
  ];

  it("figure-free items save: one row, no commission", async () => {
    const tx = fakeTx();
    const out = await writeIfFigureFree(tx, lockedOf(), bump(), ctx());
    expect(out).toBeTruthy();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(rows(tx)[0].meta.figureFree).toBe(true);
  });

  it("figure-free header-only save: one row", async () => {
    const tx = fakeTx();
    await writeIfFigureFree(tx, lockedOf(), null, ctx({ dto: { notes: "n" } }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("an unchanged save writes no row and no status update", async () => {
    const tx = fakeTx();
    await writeIfFigureFree(
      tx,
      lockedOf(),
      items,
      ctx({ issueDate: cur().issueDate, due: { dueDate: FUTURE, depositDueDate: null } }),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("a DRAFT through writeIfFigureFree is null: no row", async () => {
    const tx = fakeTx();
    expect(await writeIfFigureFree(tx, lockedOf(), bump(), ctx({ mode: "DRAFT" }))).toBeNull();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("the service wiring (structural pins)", () => {
  const svc = readFileSync(join(__dirname, "invoices.service.ts"), "utf8");
  it("afterIssuedEditInTx( appears exactly twice: the items transaction and the header transaction", () => {
    expect(svc.match(/afterIssuedEditInTx\(/g)).toHaveLength(2);
  });
  it("both calls are money calls and neither sits in the DRAFT-only header path", () => {
    const calls = svc.split("afterIssuedEditInTx(").slice(1);
    for (const c of calls) expect(c.slice(0, 220)).toContain("money: true");
    const headerAt = svc.lastIndexOf("afterIssuedEditInTx(");
    expect(headerAt).toBeGreaterThan(svc.indexOf("planHeaderOnlyTotals(locked, dto, mode)"));
  });
  it("the items call follows the ledger resync, so the commission reads the settled invoice", () => {
    expect(svc.indexOf("afterIssuedEditInTx(")).toBeGreaterThan(
      svc.indexOf("await this.resyncInvoiceLedger(id, inv.orderId ?? null, u.items ?? [], tx)"),
    );
  });
});
