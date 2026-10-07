// PR4a DB-4 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never by the builder).
// The manual activation and the auto-void of the OPEN invoices it covers land or roll back as ONE transaction.
// The tenant is a throwaway e2e-* slug of class TEST; every row is removed in afterAll.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "./audit-actions.constant";
import { PlatformAdminService } from "./platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DAY = 86_400_000;
let pool: Pool;
let prisma: PrismaClient;
let svc: PlatformAdminService;
let tenantId: string;
let emit: jest.Mock;
const SLUG = `e2e-rfinv4a-${Date.now()}`;
const ACTOR_DTO = { plan: "PROFESSIONAL", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" };
let seq = 0;

/** An OPEN invoice whose period sits wholly inside the next 30 days (so a 30-day activation covers it). */
async function coveredInvoice(): Promise<{ id: string; periodKey: string }> {
  const n = ++seq;
  const start = new Date(Date.now() + (3 + n) * DAY);
  const periodKey = start.toISOString();
  const r = await prisma.rfInvoice.create({
    data: {
      tenantId,
      number: `RF-2097-${String(Date.now() % 100000).padStart(5, "0")}${n}`,
      amount: 499,
      status: "OPEN",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 5 * DAY),
      periodKey,
      dueDate: start,
    },
  });
  return { id: r.id, periodKey };
}
const statusOf = async (id: string) =>
  (await prisma.rfInvoice.findUniqueOrThrow({ where: { id } })).status;
const voidAudits = () =>
  prisma.auditLog.count({
    where: { tenantId, action: AdminAuditAction.RF_INVOICE_VOIDED, entityType: ADMIN_AUDIT_ENTITY },
  });
const subRow = () => prisma.tenantSubscription.findUnique({ where: { tenantId } });

describeDb("manual activation auto-void (DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    assertTestTenant(SLUG);
    const t = await prisma.tenant.create({
      data: { name: "Acme Wholesale (test)", slug: SLUG, class: "TEST", status: "TRIAL" },
    });
    tenantId = t.id;
    // the seeded, published catalog supplies the FK target for TenantSubscription.planVersionId
    const version = await prisma.planVersion.findFirstOrThrow({ where: { status: "PUBLISHED" } });
    emit = jest.fn().mockResolvedValue({});
    svc = new PlatformAdminService(
      prisma as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getPublishedVersion: jest.fn().mockResolvedValue({
          id: version.id,
          definitions: [{ planKey: "SCALE", monthlyPrice: 499, isCustom: false }],
        }),
      } as any,
      {} as any,
      { invalidate: jest.fn() } as any,
      { emit } as any,
      {} as any,
      { invalidate: jest.fn() } as any,
      {} as any,
      { priceSubscription: jest.fn().mockReturnValue(499) } as any,
      { upsert: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {
        isEnabled: jest.fn().mockResolvedValue(false),
        prepare: jest.fn(),
        onPlanChange: jest.fn(),
        transactionOptions: jest.fn().mockReturnValue(undefined),
        invalidateCaches: jest.fn(),
      } as any,
    );
  });
  afterAll(async () => {
    try {
      if (tenantId) {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.billingEvent.deleteMany({ where: { tenantId } });
        await prisma.rfInvoice.deleteMany({ where: { tenantId } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("an activation failure after the void point rolls the void back: invoice stays OPEN, no audit", async () => {
    const inv = await coveredInvoice();
    const paid = await coveredInvoice();
    await prisma.rfInvoice.update({ where: { id: paid.id }, data: { status: "PAID" } });
    emit.mockRejectedValueOnce(new Error("activation failed after the void"));

    await expect(
      svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a"),
    ).rejects.toThrow("activation failed after the void");

    expect(await statusOf(inv.id)).toBe("OPEN");
    expect(await voidAudits()).toBe(0);
    expect(await subRow()).toBeNull(); // the subscription write rolled back too
  });

  it("a void failure rolls the activation back (a colliding void periodKey -> unique violation)", async () => {
    const inv = await coveredInvoice();
    // squat the exact key the void will write, so the void's UPDATE violates (tenantId, periodKey)
    await prisma.rfInvoice.create({
      data: {
        tenantId,
        number: `RF-2097-SQ${Date.now() % 100000}`,
        amount: 1,
        status: "VOID",
        periodKey: `${inv.periodKey}:void:${inv.id}`,
      },
    });

    await expect(
      svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a"),
    ).rejects.toThrow();

    expect(await statusOf(inv.id)).toBe("OPEN");
    expect(await subRow()).toBeNull();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
      "TRIAL",
    );
    await prisma.rfInvoice.deleteMany({ where: { tenantId, status: "VOID" } });
  });

  it("success: the covered OPEN invoice is VOID with its reason + audit in the same commit; PAID untouched", async () => {
    await prisma.rfInvoice.deleteMany({ where: { tenantId } });
    const open = await coveredInvoice();
    const paid = await coveredInvoice();
    await prisma.rfInvoice.update({ where: { id: paid.id }, data: { status: "PAID" } });

    await svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a");

    const v = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: open.id } });
    expect(v.status).toBe("VOID");
    expect(v.voidReason).toMatch(/^Covered by manual activation on \d{4}-\d{2}-\d{2}$/);
    expect(v.voidedAt).not.toBeNull();
    expect(v.periodKey).toBe(`${open.periodKey}:void:${open.id}`);
    expect(await statusOf(paid.id)).toBe("PAID");
    expect(await voidAudits()).toBe(1);
    expect((await subRow())?.externalPayment).toBe(true);
  });
});
