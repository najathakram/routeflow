// PR3 DB-4 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never by the builder).
// The cooldown claim is a real compare-and-set: two concurrent manual resends of one invoice produce ONE
// send, ONE audit row and a cooldown outcome for the loser. The notifier is a stub (the email itself is
// proved in rf-invoice-mailer.service.spec.ts); what is under test here is the SQL claim.
// The tenant is a throwaway e2e-* slug of class TEST; every row is removed in afterAll.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { RfInvoiceMailerService } from "./rf-invoice-mailer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

let pool: Pool;
let prisma: PrismaClient;
let svc: RfInvoiceMailerService;
let tenantId: string;
const SLUG = `e2e-rfinv3-${Date.now()}`;
const ACTOR = "sa-db-4";
const NOW = new Date("2026-10-20T14:00:00.000Z");
const notifier = { sendRfInvoice: jest.fn(async () => ({ status: "sent", recipients: 1 })) };
let seq = 0;

async function openInvoice(): Promise<string> {
  const n = ++seq;
  const start = new Date(NOW.getTime() + n * 86_400_000);
  const r = await prisma.rfInvoice.create({
    data: {
      tenantId,
      number: `RF-2097-${String(Date.now() % 100000).padStart(5, "0")}${n}`,
      amount: 149,
      status: "OPEN",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 30 * 86_400_000),
      periodKey: start.toISOString(),
      dueDate: start,
    },
  });
  return r.id;
}

const audits = () =>
  prisma.auditLog.count({
    where: { tenantId, action: AdminAuditAction.RF_INVOICE_SENT, entityType: ADMIN_AUDIT_ENTITY },
  });

describeDb("rf invoice mailer (DB)", () => {
  const OLD = {
    mode: process.env.RF_INVOICING_MODE,
    slugs: process.env.RF_INVOICE_TEST_TENANT_SLUGS,
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    assertTestTenant(SLUG);
    process.env.RF_INVOICING_MODE = "live";
    process.env.RF_INVOICE_TEST_TENANT_SLUGS = SLUG;
    const t = await prisma.tenant.create({
      data: { name: "Acme Wholesale (test)", slug: SLUG, class: "TEST" },
    });
    tenantId = t.id;
    svc = new RfInvoiceMailerService(prisma as any, notifier as any);
  });
  afterAll(async () => {
    if (OLD.mode === undefined) delete process.env.RF_INVOICING_MODE;
    else process.env.RF_INVOICING_MODE = OLD.mode;
    if (OLD.slugs === undefined) delete process.env.RF_INVOICE_TEST_TENANT_SLUGS;
    else process.env.RF_INVOICE_TEST_TENANT_SLUGS = OLD.slugs;
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
  beforeEach(() => notifier.sendRfInvoice.mockClear());

  it("DB-4: two concurrent manual resends -> one sent, one cooldown, one email, one audit row", async () => {
    const id = await openInvoice();
    const [a, b] = await Promise.all([
      svc.sendManual(id, ACTOR, NOW),
      svc.sendManual(id, ACTOR, NOW),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["cooldown", "sent"]);
    expect(notifier.sendRfInvoice).toHaveBeenCalledTimes(1);
    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id } });
    expect(row.sendCount).toBe(1);
    expect(row.lastSentAt?.getTime()).toBe(NOW.getTime());
    expect(await audits()).toBe(1);
  });

  it("DB-4: a no-recipient send restores lastSentAt in the database", async () => {
    const id = await openInvoice();
    notifier.sendRfInvoice.mockResolvedValueOnce({ status: "no_recipients", recipients: 0 } as any);
    const r = await svc.sendManual(id, ACTOR, NOW);
    expect(r.outcome).toBe("no_recipients");
    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id } });
    expect(row.lastSentAt).toBeNull();
    expect(row.sendCount).toBe(0);
  });

  it("DB-4: a PAID invoice is not_open and is never emailed", async () => {
    const id = await openInvoice();
    await prisma.rfInvoice.update({ where: { id }, data: { status: "PAID", paidAt: NOW } });
    const r = await svc.sendManual(id, ACTOR, NOW);
    expect(r.outcome).toBe("not_open");
    expect(notifier.sendRfInvoice).not.toHaveBeenCalled();
  });
});
