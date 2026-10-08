// PR2 DB-2 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never by the builder).
// The tenant is a throwaway e2e-* slug of class TEST; every row is removed in afterAll.
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "./audit-actions.constant";
import { RfInvoicesAdminService } from "./rf-invoices.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

let pool: Pool;
let prisma: PrismaClient;
let svc: RfInvoicesAdminService;
let tenantId: string;
const SLUG = `e2e-rfinv2-${Date.now()}`;
const ACTOR = "sa-db-2";
const START = new Date("2026-10-12T00:00:00.000Z");
let seq = 0;

async function openInvoice(): Promise<string> {
  const n = ++seq;
  const r = await prisma.rfInvoice.create({
    data: {
      tenantId,
      number: `RF-2098-${String(Date.now() % 100000).padStart(5, "0")}${n}`,
      amount: 149,
      status: "OPEN",
      periodStart: new Date(START.getTime() + n * 86_400_000),
      periodEnd: new Date(START.getTime() + (n + 30) * 86_400_000),
      periodKey: new Date(START.getTime() + n * 86_400_000).toISOString(),
      dueDate: new Date(START.getTime() + n * 86_400_000),
    },
  });
  return r.id;
}

const audits = (action: string) =>
  prisma.auditLog.count({ where: { tenantId, action, entityType: ADMIN_AUDIT_ENTITY } });

describeDb("rf invoices admin actions (DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    assertTestTenant(SLUG);
    const t = await prisma.tenant.create({
      data: { name: "Acme Wholesale (test)", slug: SLUG, class: "TEST" },
    });
    tenantId = t.id;
    svc = new RfInvoicesAdminService(prisma as any, {} as any, {} as any);
  });
  afterAll(async () => {
    try {
      if (tenantId) {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.rfInvoice.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("DB-2: two concurrent mark-paid calls -> one PAID, one audit row, the other 409", async () => {
    const id = await openInvoice();
    const results = await Promise.allSettled([
      svc.markPaid(id, { method: "CASH" }, ACTOR),
      svc.markPaid(id, { method: "CASH" }, ACTOR),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PAID");
    expect(row.paidById).toBe(ACTOR);
    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        action: AdminAuditAction.RF_INVOICE_MARKED_PAID,
        entityType: ADMIN_AUDIT_ENTITY,
      },
    });
    expect(rows.filter((a) => (a.meta as any)?.invoiceId === id)).toHaveLength(1);
  });

  it("DB-2: a concurrent mark-paid and void -> exactly one wins, the other 409, one audit row", async () => {
    const id = await openInvoice();
    const before =
      (await audits(AdminAuditAction.RF_INVOICE_MARKED_PAID)) +
      (await audits(AdminAuditAction.RF_INVOICE_VOIDED));
    const results = await Promise.allSettled([
      svc.markPaid(id, { method: "CASH" }, ACTOR),
      svc.voidInvoice(id, { reason: "racing the payment" }, ACTOR),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id } });
    expect(["PAID", "VOID"]).toContain(row.status);
    const after =
      (await audits(AdminAuditAction.RF_INVOICE_MARKED_PAID)) +
      (await audits(AdminAuditAction.RF_INVOICE_VOIDED));
    expect(after - before).toBe(1);
  });

  it("DB-2: void frees the period for a new live row; reopen restores OPEN", async () => {
    const id = await openInvoice();
    const voided = await svc.voidInvoice(id, { reason: "wrong price" }, ACTOR);
    expect(voided.status).toBe("VOID");
    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id } });
    expect(row.periodKey).toBe(`${row.periodStart!.toISOString()}:void:${id}`);

    const paidId = await openInvoice();
    await svc.markPaid(paidId, { method: "CASH" }, ACTOR);
    const reopened = await svc.reopen(paidId, { reason: "cheque bounced" }, ACTOR);
    expect(reopened.status).toBe("OPEN");
    const again = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: paidId } });
    expect(again).toMatchObject({ paidAt: null, paidMethod: null, paidRef: null, paidById: null });
  });
});
