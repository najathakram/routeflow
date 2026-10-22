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
import { RfInvoiceIssuerService } from "../billing/rf-invoice/rf-invoice-issuer.service";
import { nextBillingWindow } from "../billing/rf-invoice/calendar-windows";

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
// When set, the RF_INVOICE_VOIDED audit row (written right after the void's CAS update) throws.
let failVoidAudit = false;
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
/**
 * A PAID invoice that ends before any window the tests anchor on (PR4a M2 refuses a window that runs over a PAID
 * period, so "PAID untouched" is proved with a paid row that is BEFORE the window, as in real life).
 */
const paidBeforeWindow = () => monthlyInvoice(new Date(Date.now() - 45 * DAY), "PAID");
const statusOf = async (id: string) =>
  (await prisma.rfInvoice.findUniqueOrThrow({ where: { id } })).status;
const voidAudits = () =>
  prisma.auditLog.count({
    where: { tenantId, action: AdminAuditAction.RF_INVOICE_VOIDED, entityType: ADMIN_AUDIT_ENTITY },
  });
const subRow = () => prisma.tenantSubscription.findUnique({ where: { tenantId } });

/** An invoice for [start, start+30d) with the issuer's own periodKey (the period start, ISO). */
async function monthlyInvoice(
  start: Date,
  status: "OPEN" | "PAID",
): Promise<{ id: string; number: string }> {
  const n = ++seq;
  return prisma.rfInvoice.create({
    data: {
      tenantId,
      number: `RF-2097-M${String(Date.now() % 100000).padStart(5, "0")}${n}`,
      amount: 499,
      status,
      periodStart: start,
      periodEnd: new Date(start.getTime() + 30 * DAY),
      periodKey: start.toISOString(),
      dueDate: start,
    },
    select: { id: true, number: true },
  });
}

/**
 * The REAL issuer (its findFirst reads run against the DB, nothing stubbed there); only the price builder is a
 * fixed draft. The cron is not started: a class-TEST tenant is not one of its candidates, so the same loop it
 * runs per subscription (windowsFor with the 7-day lead, then issuePeriod per window) is driven here directly.
 */
function realIssuer(): RfInvoiceIssuerService {
  return new (RfInvoiceIssuerService as any)(prisma, {
    build: async () => ({
      ok: true,
      lines: [
        { kind: "PLAN", code: "SCALE", label: "Scale", quantity: 1, unitAmount: 499, amount: 499 },
      ],
      total: 499,
      needsReview: false,
      currency: "USD",
    }),
  }) as RfInvoiceIssuerService;
}
async function runIssuer(issuer: RfInvoiceIssuerService, now: Date, leadDays?: number) {
  const sub = (await subRow())!;
  const out: Array<{ window: { periodStart: Date; periodEnd: Date }; status: string }> = [];
  for (const window of await issuer.windowsFor(sub as any, now, leadDays)) {
    out.push({ window, status: (await issuer.issuePeriod(sub as any, window, now)).status });
  }
  return out;
}

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
                    if (
                      failVoidAudit &&
                      args?.data?.action === AdminAuditAction.RF_INVOICE_VOIDED
                    ) {
                      throw new Error("injected: void audit write failed");
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
    failVoidAudit = false;
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
    failVoidAudit = false;
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
    const paid = await paidBeforeWindow();
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

  it("a void failure rolls the activation back (the void's audit write fails after its CAS update)", async () => {
    const inv = await coveredInvoice();
    failVoidAudit = true; // the void's UPDATE has run; its audit row throws -> one transaction, one rollback

    await expect(
      svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a"),
    ).rejects.toThrow("injected: void audit write failed");

    expect(await statusOf(inv.id)).toBe("OPEN");
    expect(await voidAudits()).toBe(0);
    expect(await subRow()).toBeNull();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
      "TRIAL",
    );
  });

  it("success: the covered OPEN invoice is VOID with its reason + audit in the same commit; PAID untouched", async () => {
    const open = await coveredInvoice();
    const paid = await paidBeforeWindow();

    await svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a");

    const v = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: open.id } });
    expect(v.status).toBe("VOID");
    expect(v.voidReason).toMatch(/^Covered by manual activation on \d{4}-\d{2}-\d{2}$/);
    expect(v.voidedAt).not.toBeNull();
    // an activation void keeps the key ("settled outside, period consumed"): only the admin void renames it
    expect(v.periodKey).toBe(open.periodKey);
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

  // The defect this pins: the activation used to rename the voided row's periodKey, and the issuer's catch-up
  // branch (a PAID prior row whose periodEnd == P) then re-billed [P, P+30d), the period the activation had
  // just settled. The void keeps the key, so (tenantId, periodKey) holds the slot and the issuer says 'exists'.
  describe("an activation void keeps the period consumed against the REAL issuer", () => {
    // PAID [P-30d, P) + OPEN [P, P+30d); a 30-day activation at P-3d anchors on P and covers the OPEN row.
    async function activateAheadOfOpenInvoice() {
      const P = new Date(Date.now() + 3 * DAY);
      const paid = await monthlyInvoice(new Date(P.getTime() - 30 * DAY), "PAID");
      const open = await monthlyInvoice(P, "OPEN");
      await svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a");
      return { P, paid, open };
    }
    const forPeriod = (P: Date) =>
      prisma.rfInvoice.findMany({ where: { tenantId, periodStart: P } });

    it("the OPEN row is VOID at its ORIGINAL periodKey; the cron at activation time and at P+23d bills only [P+30d, P+60d)", async () => {
      const { P, paid, open } = await activateAheadOfOpenInvoice();

      const v = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: open.id } });
      expect(v.status).toBe("VOID");
      expect(v.periodKey).toBe(P.toISOString());
      expect(await statusOf(paid.id)).toBe("PAID");
      const sub = await subRow();
      expect(sub?.periodStart?.getTime()).toBe(P.getTime());
      expect(sub?.periodEnd?.getTime()).toBe(P.getTime() + 30 * DAY);

      const issuer = realIssuer();
      // the cron at `now` (P-3d): the catch-up proposes [P, P+30d) (the PAID row ends at P) and finds it taken
      const atNow = await runIssuer(issuer, new Date(P.getTime() - 3 * DAY));
      expect(atNow.map((r) => r.status)).toEqual(["exists"]);
      expect(await forPeriod(P)).toHaveLength(1); // only the VOID row: nothing new for [P, P+30d)
      expect(await prisma.rfInvoice.count({ where: { tenantId } })).toBe(2);

      // the cron at P+23d: the next period starts within the 7-day lead -> [P+30d, P+60d) is issued
      const later = await runIssuer(issuer, new Date(P.getTime() + 23 * DAY));
      expect(later.map((r) => r.status)).toEqual(["exists", "issued"]);
      expect(await forPeriod(P)).toHaveLength(1);
      const next = await prisma.rfInvoice.findMany({
        where: { tenantId, periodStart: new Date(P.getTime() + 30 * DAY) },
      });
      expect(next).toHaveLength(1);
      // the window end is EXACTLY what the production calendar helper gives for the period after the
      // subscription's end (P+30d), the same helper the issuer and rollCycles use (SA-837 row 499)
      const end = next[0].periodEnd!;
      const expected = nextBillingWindow(new Date(P.getTime() + 30 * DAY), "MONTHLY");
      expect(end.toISOString()).toBe(expected.periodEnd.toISOString());
      expect(next[0].status).toBe("OPEN");
    });

    it("issue-now (leadDays Infinity) at activation time also creates nothing for [P, P+30d)", async () => {
      const { P } = await activateAheadOfOpenInvoice();

      const out = await runIssuer(realIssuer(), new Date(P.getTime() - 3 * DAY), Infinity);

      // window 1 is the catch-up for [P, P+30d): 'exists'. Window 2 is the NEXT period, which issue-now issues.
      expect(out[0]).toMatchObject({ status: "exists" });
      expect(out[0].window.periodStart.getTime()).toBe(P.getTime());
      const rows = await forPeriod(P);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("VOID");
    });
  });

  it("an activation whose window already ended is refused 409 ACTIVATION_PERIOD_ALREADY_ENDED and writes nothing", async () => {
    // OPEN [now-40d, now-10d): the 30-day window anchors there and ends 10 days ago
    const stale = await monthlyInvoice(new Date(Date.now() - 40 * DAY), "OPEN");

    await expect(
      svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a"),
    ).rejects.toMatchObject({
      response: {
        code: "ACTIVATION_PERIOD_ALREADY_ENDED",
        message: expect.stringContaining("is still open and this payment's window ended on"),
        invoiceNumber: stale.number,
        minDays: expect.any(Number),
      },
    });

    expect(await statusOf(stale.id)).toBe("OPEN");
    expect(await voidAudits()).toBe(0);
    expect(await subRow()).toBeNull();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
      "TRIAL",
    );
  });

  const markers = () =>
    prisma.auditLog.findMany({
      where: {
        tenantId,
        action: AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER,
        entityType: ADMIN_AUDIT_ENTITY,
      },
      orderBy: { createdAt: "asc" },
    });

  it("M1: the marker records the ANCHORED start (the open invoice's period), not the click time", async () => {
    const P = new Date(Date.now() + 10 * DAY);
    await monthlyInvoice(P, "OPEN");

    await svc.activateManualSubscription(tenantId, ACTOR_DTO as any, "sa-4a");

    const [marker] = await markers();
    expect((marker.meta as any).periodStart).toBe(P.toISOString());
    expect((await subRow())?.periodStart?.toISOString()).toBe(P.toISOString());
    expect((marker.meta as any).voidedInvoiceIds).toHaveLength(1);
  });

  it("M2: OPEN + PAID + OPEN with a window that runs over the paid month -> 409 ACTIVATION_OVERLAPS_PAID_PERIOD, nothing written", async () => {
    const first = new Date(Date.now() - 2 * DAY);
    const aug = await monthlyInvoice(first, "OPEN");
    await monthlyInvoice(new Date(first.getTime() + 30 * DAY), "PAID");
    const oct = await monthlyInvoice(new Date(first.getTime() + 60 * DAY), "OPEN");

    await expect(
      svc.activateManualSubscription(
        tenantId,
        { ...ACTOR_DTO, billingPeriodDays: 90 } as any,
        "sa-4a",
      ),
    ).rejects.toMatchObject({ response: { code: "ACTIVATION_OVERLAPS_PAID_PERIOD", maxDays: 30 } });

    expect(await statusOf(aug.id)).toBe("OPEN");
    expect(await statusOf(oct.id)).toBe("OPEN");
    expect(await voidAudits()).toBe(0);
    expect(await subRow()).toBeNull();
  });

  it("M3: a double-click (two concurrent identical requests) records one period and one marker", async () => {
    await monthlyInvoice(new Date(Date.now() + 3 * DAY), "OPEN");
    const dto = { ...ACTOR_DTO, paymentRef: "CHQ-4A-DBL" } as any;

    const [a, b] = await Promise.all([
      svc.activateManualSubscription(tenantId, dto, "sa-4a"),
      svc.activateManualSubscription(tenantId, dto, "sa-4a"),
    ]);

    expect([a, b].filter((r: any) => r.repeated === true)).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
    const sub = (await subRow())!;
    expect(sub.periodStart?.toISOString()).toBe((a as any).periodStart.toISOString());
    expect((b as any).periodEnd.toISOString()).toBe((a as any).periodEnd.toISOString());
    // a DIFFERENT reference is a new payment, not a repeat
    await svc.activateManualSubscription(tenantId, { ...dto, paymentRef: "CHQ-4A-OTHER" }, "sa-4a");
    expect(await markers()).toHaveLength(2);
  });
});
