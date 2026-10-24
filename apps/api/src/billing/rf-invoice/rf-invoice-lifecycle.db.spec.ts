// PR1 DB-1 / DB-3 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never here).
// Tenants are throwaway e2e-* slugs; every row is removed in afterAll.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { RF_INVOICE_PERIOD_INDEX } from "./rf-invoice.constants";
import { RfInvoiceIssuerService } from "./rf-invoice-issuer.service";
import { uniqueViolationOn } from "../../common/prisma-unique";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

let pool: Pool;
let prisma: PrismaClient;
const SLUG = `e2e-rfinv-${Date.now()}`;
const NOW = new Date("2026-10-07T00:20:00.000Z");
let tenantId: string;

const WINDOW = {
  periodStart: new Date("2026-10-12T00:00:00.000Z"),
  periodEnd: new Date("2026-11-11T00:00:00.000Z"),
};

const row = (over: Record<string, unknown> = {}) => ({
  tenantId,
  number: `RF-2099-${String(Math.floor(Math.random() * 9000) + 1000)}`,
  amount: 149,
  status: "OPEN",
  periodStart: WINDOW.periodStart,
  periodEnd: WINDOW.periodEnd,
  periodKey: WINDOW.periodStart.toISOString(),
  dueDate: WINDOW.periodStart,
  ...over,
});

describeDb("RfInvoice manual lifecycle (DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    assertTestTenant(SLUG);
    const t = await prisma.tenant.create({
      data: { name: "Acme Wholesale (test)", slug: SLUG, class: "TEST" },
    });
    tenantId = t.id;
  });
  // Runs even when a test failed early: every step is independent and tenant-scoped.
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

  it("DB-1: the new columns exist with their defaults, and (tenantId, periodKey) is unique", async () => {
    const a = await prisma.rfInvoice.create({ data: row() as any });
    expect(a).toMatchObject({
      currency: "USD",
      sendCount: 0,
      needsReview: false,
      paidAt: null,
      voidedAt: null,
    });
    let err: unknown;
    await prisma.rfInvoice.create({ data: row() as any }).catch((e) => (err = e));
    expect(uniqueViolationOn(err, RF_INVOICE_PERIOD_INDEX, { exact: true })).toBe(true);
  });

  it("DB-1: after a void (periodKey suffixed) a new live row for the same period is allowed", async () => {
    const live = await prisma.rfInvoice.findFirstOrThrow({ where: { tenantId, status: "OPEN" } });
    await prisma.rfInvoice.update({
      where: { id: live.id },
      data: { status: "VOID", voidedAt: NOW, periodKey: `${live.periodKey}:void:${live.id}` },
    });
    const fresh = await prisma.rfInvoice.create({ data: row() as any });
    expect(fresh.status).toBe("OPEN");
  });

  it("DB-3: a concurrent cron issue and an issue-now for one period -> exactly one row", async () => {
    await prisma.rfInvoice.deleteMany({ where: { tenantId } });
    const svc = new (RfInvoiceIssuerService as any)(prisma, {
      build: async () => ({
        ok: true,
        lines: [
          {
            kind: "PLAN",
            code: "STARTER",
            label: "Starter",
            quantity: 1,
            unitAmount: 149,
            amount: 149,
          },
        ],
        total: 149,
        needsReview: false,
        currency: "USD",
      }),
    }) as RfInvoiceIssuerService;
    const sub = {
      tenantId,
      cycle: "MONTHLY",
      planKey: "STARTER",
      periodStart: new Date("2026-09-12T00:00:00.000Z"),
      periodEnd: WINDOW.periodStart,
    };
    const results = await Promise.all([
      svc.issuePeriod(sub as any, WINDOW, NOW),
      svc.issuePeriod(sub as any, WINDOW, NOW),
      svc.issuePeriod(sub as any, WINDOW, NOW),
    ]);
    expect(results.filter((r) => r.status === "issued")).toHaveLength(1);
    expect(await prisma.rfInvoice.count({ where: { tenantId } })).toBe(1);
    const notices = await prisma.auditLog.count({
      where: { tenantId, action: "RF_INVOICE_ISSUED" },
    });
    expect(notices).toBe(1);
    await prisma.auditLog.deleteMany({ where: { tenantId } });
  });
});
