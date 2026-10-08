// PR4a DB-4 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never by the builder).
// The manual activation and the auto-void of the OPEN invoices it covers land or roll back as ONE transaction.
// Every test gets its OWN throwaway e2e-* tenant (class TEST, status TRIAL), removed in afterEach, so no test
// can see another's activation. A class-TEST tenant never crosses into the paying set, so the billing-event
// emit is NOT reached; the post-void failure is injected on the activation's last in-tx write instead.
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
const tenantIds: string[] = [];
// When set, the activation's marker audit row (its LAST in-transaction write, after the void) throws.
let failMarker = false;
let createdVersionId: string | undefined; // only a version this spec created is ever deleted
const SLUG_BASE = `e2e-rfinv4a-${Date.now()}`;
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

/**
 * The real client, except that while `failMarker` is set the activation's transaction throws when it writes
 * the TENANT_MANUAL_ACTIVATION_MARKER audit row - the last write of the transaction, strictly after the
 * subscription upsert and the void. Everything else is delegated untouched (methods bound to their owner).
 */
function failingMarkerPrisma(real: PrismaClient): PrismaClient {
  const bound = (o: any) =>
    new Proxy(o, {
      get: (t, k) => (typeof t[k] === "function" ? t[k].bind(t) : t[k]),
    });
  const wrapTx = (tx: any) =>
    new Proxy(tx, {
      get: (t, k) => {
        if (k === "auditLog") {
          return new Proxy(t.auditLog, {
            get: (a, m) =>
              m === "create"
                ? (args: any) => {
                    if (
                      failMarker &&
                      args?.data?.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER
                    ) {
                      throw new Error("injected: activation marker write failed");
                    }
                    return a.create(args);
                  }
                : typeof a[m] === "function"
                  ? a[m].bind(a)
                  : a[m],
          });
        }
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      },
    });
  return new Proxy(real as any, {
    get: (t, k) => {
      if (k === "$transaction") {
        return (fn: any, opts?: any) =>
          typeof fn === "function"
            ? t.$transaction((tx: any) => fn(wrapTx(tx)), opts)
            : t.$transaction(fn, opts);
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v && typeof v === "object" ? bound(v) : v;
    },
  }) as PrismaClient;
}

async function cleanupTenant(id: string) {
  await prisma.auditLog.deleteMany({ where: { tenantId: id } });
  await prisma.billingEvent.deleteMany({ where: { tenantId: id } });
  await prisma.rfInvoice.deleteMany({ where: { tenantId: id } });
  await prisma.tenantSubscription.deleteMany({ where: { tenantId: id } });
  await prisma.tenant.deleteMany({ where: { id } });
}

describeDb("manual activation auto-void (DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    // Hermetic (a fresh CI database has no seeded catalog): reuse a PUBLISHED PlanVersion when one exists,
    // otherwise create a throwaway one as the FK target for TenantSubscription.planVersionId.
    let version = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
    if (!version) {
      // int4 column - never derive from Date.now()
      const next =
        ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
      version = await prisma.planVersion.create({
        data: {
          version: next,
          status: "PUBLISHED",
          publishedAt: new Date(),
          notes: "qa fixture - created by platform-admin-activation-void.db.spec.ts",
        },
      });
      createdVersionId = version.id;
    }
    emit = jest.fn().mockResolvedValue({});
    // Named, then mapped in the constructor's order. Keep this list in step with PlatformAdminService's
    // constructor: prisma, jwtService, config, emailService, billingService, platformPricingService,
    // planCatalogService, proration, entitlementsService, billingEventService, meterService,
    // tenantStatusGuard, auditService, mrrService, tenantMirror, featureOverrides, planTransition.
    const deps = {
      prisma: failingMarkerPrisma(prisma),
      jwtService: {},
      config: { get: jest.fn() },
      emailService: {},
      billingService: {},
      platformPricingService: {},
      planCatalogService: {
        getPublishedVersion: jest.fn().mockResolvedValue({
          id: version.id,
          definitions: [{ planKey: "SCALE", monthlyPrice: 499, isCustom: false }],
        }),
      },
      proration: {},
      entitlementsService: { invalidate: jest.fn() },
      billingEventService: { emit },
      meterService: {},
      tenantStatusGuard: { invalidate: jest.fn() },
      // the post-commit recordAdminAction trail row; the in-tx audit rows under test go through prisma
      auditService: { log: jest.fn().mockResolvedValue(undefined) },
      mrrService: { priceSubscription: jest.fn().mockReturnValue(499) },
      tenantMirror: { upsert: jest.fn().mockResolvedValue(undefined) },
      featureOverrides: {},
      planTransition: {
        isEnabled: jest.fn().mockResolvedValue(false),
        prepare: jest.fn(),
        onPlanChange: jest.fn(),
        transactionOptions: jest.fn().mockReturnValue(undefined),
        invalidateCaches: jest.fn(),
      },
    };
    svc = new PlatformAdminService(
      ...(Object.values(deps) as unknown as ConstructorParameters<typeof PlatformAdminService>),
    );
  });
  beforeEach(async () => {
    failMarker = false;
    const slug = `${SLUG_BASE}-${tenantIds.length}`;
    assertTestTenant(slug);
    const t = await prisma.tenant.create({
      data: { name: "Acme Wholesale (test)", slug, class: "TEST", status: "TRIAL" },
    });
    tenantId = t.id;
    tenantIds.push(t.id);
  });
  afterEach(async () => {
    failMarker = false;
    if (tenantId) await cleanupTenant(tenantId);
  });
  afterAll(async () => {
    try {
      for (const id of tenantIds) await cleanupTenant(id); // idempotent: a straggler only
      if (createdVersionId) {
        await prisma.planVersion.deleteMany({ where: { id: createdVersionId } });
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
    failMarker = true; // the marker write comes after the subscription upsert AND the void

    await expect(
      svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a"),
    ).rejects.toThrow("injected: activation marker write failed");

    expect(await statusOf(inv.id)).toBe("OPEN");
    expect(await voidAudits()).toBe(0);
    expect(await subRow()).toBeNull(); // the subscription write rolled back too
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
      "TRIAL",
    );
    expect(await statusOf(paid.id)).toBe("PAID");
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
  });

  it("success: the covered OPEN invoice is VOID with its reason + audit in the same commit; PAID untouched", async () => {
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

  it("a partially overlapping OPEN invoice stays OPEN, is flagged needsReview, with exactly one notice", async () => {
    // The window starts at the earliest OPEN invoice (here 5 days ago) and runs 14 days: a monthly invoice
    // [-5d, +25d) is only partly inside it.
    const shortActivation = { ...ACTOR_DTO, billingPeriodDays: 14 };
    const startsBefore = new Date(Date.now() - 5 * DAY);
    const partial = await prisma.rfInvoice.create({
      data: {
        tenantId,
        number: `RF-2097-PT${Date.now() % 100000}`,
        amount: 499,
        status: "OPEN",
        periodStart: startsBefore,
        periodEnd: new Date(Date.now() + 25 * DAY),
        periodKey: startsBefore.toISOString(),
        dueDate: startsBefore,
      },
    });
    const partlyAudits = () =>
      prisma.auditLog.count({
        where: { tenantId, action: AdminAuditAction.RF_INVOICE_PARTLY_COVERED },
      });
    const before = await partlyAudits();

    await svc.activateManualSubscription(tenantId, shortActivation as any, "sa-4a");
    await svc.activateManualSubscription(tenantId, shortActivation as any, "sa-4a"); // a rerun

    const row = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: partial.id } });
    expect(row.status).toBe("OPEN");
    expect(row.needsReview).toBe(true);
    expect(row.periodKey).toBe(startsBefore.toISOString());
    expect((await partlyAudits()) - before).toBe(1);
    // the subscription period was written from the earliest OPEN invoice, for the activation length
    const sub = await subRow();
    expect(sub?.periodStart?.getTime()).toBe(startsBefore.getTime());
    expect(sub?.periodEnd?.getTime()).toBe(startsBefore.getTime() + 14 * DAY);
  });
});
