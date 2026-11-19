// B430 / SA-1167 R1 K5 - DB-backed (the *.db.spec.ts lane; run by the prover on the compose DB, never by the
// builder). deleteTenant leaves a tenant's billing ledger at zero: one true-up row when it still sums to a
// non-zero value, nothing when the suspend path already booked its churn.
//
// Two e2e-* tenants of class PRODUCTION (class is what puts a tenant in MrrService's ledger sums), no
// subscription rows, so no Stripe read happens and `mrr` carries nothing for them. Absolute totals include
// whatever else the database holds, so every assertion is a difference against a baseline read first.
//   A: +100 booked 40 days ago, then made SUSPENDED by a raw write that books no delta  -> delete books -100.
//   B: +100 booked 40 days ago, then -100 booked 10 days ago (the row updateStatus books on a suspend)
//      -> delete books nothing.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { roundMoney } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingEventService } from "../billing/billing-event.service";
import { MrrService } from "../billing/mrr.service";
import { BILLING_EVENTS } from "../billing/plan-catalog.constants";
import { PlatformAdminService } from "./platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DAY = 86_400_000;
const SLUG_BASE = `e2e-b430-${Date.now()}`;
const TRUE_UP_REASON = "delete_ledger_true_up";

let pool: Pool;
let prisma: PrismaClient;
let svc: PlatformAdminService;
let events: BillingEventService;
let mrr: MrrService;
const tenantIds: string[] = [];

const sumOf = async (tenantId: string) =>
  Number(
    (await prisma.billingEvent.aggregate({ _sum: { amountDelta: true }, where: { tenantId } }))._sum
      .amountDelta ?? 0,
  );
const rowsOf = (tenantId: string) =>
  prisma.billingEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });

async function newTenant(label: string): Promise<string> {
  const slug = `${SLUG_BASE}-${label}`;
  assertTestTenant(slug);
  const t = await prisma.tenant.create({
    data: { name: `Acme ${label} (test)`, slug, class: "PRODUCTION", status: "ACTIVE" },
  });
  tenantIds.push(t.id);
  return t.id;
}

/** A ledger row at `daysAgo`, written through the real emit and then dated (emit stamps "now"). */
async function book(tenantId: string, amountDelta: number, daysAgo: number, type: string) {
  const row = await events.emit(tenantId, type as any, { seeded: "b430" }, { amountDelta });
  await prisma.billingEvent.update({
    where: { id: row.id },
    data: { createdAt: new Date(Date.now() - daysAgo * DAY) },
  });
}

async function cleanupTenant(id: string) {
  await prisma.auditLog.deleteMany({ where: { tenantId: id } });
  await prisma.billingEvent.deleteMany({ where: { tenantId: id } });
  await prisma.tenant.deleteMany({ where: { id } });
}

describeDb("deleteTenant ledger true-up (B430, DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    events = new BillingEventService(prisma as any);
    mrr = new MrrService(prisma as any);
    const deps = {
      prisma,
      jwtService: {},
      config: { get: jest.fn() },
      emailService: {},
      billingService: {},
      platformPricingService: {},
      planCatalogService: {},
      proration: {},
      entitlementsService: { invalidate: jest.fn() },
      billingEventService: events,
      meterService: {},
      tenantStatusGuard: { invalidate: jest.fn() },
      auditService: { log: jest.fn().mockResolvedValue(undefined) },
      mrrService: mrr,
      tenantMirror: {},
      featureOverrides: {},
      planTransition: {},
      stripe: { isConfigured: false },
    };
    // Same order as the constructor (see platform-admin-activation-void.db.spec.ts).
    svc = new PlatformAdminService(
      ...(Object.values(deps) as unknown as ConstructorParameters<typeof PlatformAdminService>),
    );
  });
  afterAll(async () => {
    try {
      for (const id of tenantIds) await cleanupTenant(id);
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("A books one -100 true-up, B books nothing; ledgerMrr is unchanged and B's churn stays in momDelta", async () => {
    const baseline = await mrr.computeOverview();
    const a = await newTenant("a");
    const b = await newTenant("b");
    await book(a, 100, 40, BILLING_EVENTS.PLAN_CHANGED);
    await book(b, 100, 40, BILLING_EVENTS.PLAN_CHANGED);
    await book(b, -100, 10, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED);
    // A: the raw write that books no delta (what a pre-B557 or out-of-band suspend left behind).
    await prisma.tenant.updateMany({
      where: { id: { in: [a, b] } },
      data: { status: "SUSPENDED" },
    });
    expect(await sumOf(a)).toBe(100);
    expect(await sumOf(b)).toBe(0);
    const rowsBeforeB = (await rowsOf(b)).length;

    await svc.deleteTenant(a, "admin-1");
    await svc.deleteTenant(b, "admin-1");

    // A: exactly one new row, the true-up, and the sum is back at zero.
    const aRows = await rowsOf(a);
    expect(aRows).toHaveLength(2);
    const trueUp = aRows[1];
    expect(Number(trueUp.amountDelta)).toBe(-100);
    expect(trueUp.type).toBe(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
    expect(trueUp.payload).toMatchObject({
      fromStatus: "SUSPENDED",
      toStatus: "CANCELLED",
      reason: TRUE_UP_REASON,
    });
    expect(await sumOf(a)).toBe(0);
    // B: already at zero, so delete books nothing.
    expect(await rowsOf(b)).toHaveLength(rowsBeforeB);
    expect(await sumOf(b)).toBe(0);

    // The platform total: both tenants net to 0 in ledgerMrr, so it equals the baseline; momDelta moved by
    // exactly the in-window rows: B's -100 (10 days ago) and A's true-up -100 (booked now). A read filter
    // (shape a) would drop both tenants and report a change of 0; a blind offset (shape b) would add +100 for B.
    const after = await mrr.computeOverview();
    expect(after.ledgerMrr).toBe(baseline.ledgerMrr);
    expect(roundMoney(after.momDelta - baseline.momDelta)).toBe(-200);
  });

  it("a refused delete (tenant not SUSPENDED) books no row", async () => {
    const c = await newTenant("c");
    await book(c, 100, 5, BILLING_EVENTS.PLAN_CHANGED);
    await expect(svc.deleteTenant(c, "admin-1")).rejects.toBeDefined();
    expect(await rowsOf(c)).toHaveLength(1);
    expect(await sumOf(c)).toBe(100);
  });
});
