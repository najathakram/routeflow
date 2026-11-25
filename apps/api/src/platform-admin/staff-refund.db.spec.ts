/**
 * R-2 (SA-1297) - the staff refund against real Postgres. What a mock cannot prove:
 *   test 10  a yearly record that belongs to tenant B never lets tenant A's POST write a row for either;
 *   test 11  a double submit is ONE row, the second answer carries the first row's date, reference and actor;
 *   test 12  two POSTs in parallel, both past the unlocked read, queue on the tenant row lock: one 201, one 409, one row;
 *   test 13  the row is amountDelta NULL and the tenant's sum, the MrrService ledgerMrr and its last-30-days delta do not move
 *            (a PRODUCTION-class tenant, so MrrService does count it);
 *   test 15  `getExport` never carries a refund.staff row, its reference or its note;
 *   test 16  one AuditLog row with the action, the neutral line and the label;
 *   test 18  while the rollout pause holds automatic locks, a `customer.subscription.deleted` webhook leaves the tenant ACTIVE,
 *            then a staff refund is recorded: the tenant and its subscription are untouched, MRR unchanged, neutral notice line.
 * Only the PR-4 reader (`latestYearlyPayment`, SA-1304) is mocked, with a fixture row per tenant: PR-4 is not on master.
 *
 * Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes what it made and puts the pause switch back as it found it.
 * The wall clock is pinned (L-353, only Date is faked); the fixture payment is 5 days before it. Run through `npm run local:test:db`.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));
const mockRecords = new Map<string, unknown>();
jest.mock("../billing/yearly-payment-record", () => ({
  latestYearlyPayment: jest.fn(async (_db: unknown, tenantId: string) => {
    return mockRecords.get(tenantId) ?? null;
  }),
}));

import { randomUUID } from "crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import {
  describeDb,
  requireLocalDatabaseUrl,
  waitForBlockedSession,
} from "../common/testing/db-spec";
import { pinWallClock } from "../testing/pin-clock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AutoLockSwitchService } from "../billing/auto-lock-switch.service";
import { AUTO_LOCKS_PAUSED_KEY } from "../billing/auto-lock-gate";
import { BillingEventService } from "../billing/billing-event.service";
import { BillingService } from "../billing/billing.service";
import { DunningService } from "../billing/dunning.service";
import { MrrService } from "../billing/mrr.service";
import { SubscriptionService } from "../billing/subscription.service";
import type { YearlyPaymentRecord } from "../billing/yearly-payment-record";
import { StaffRefundDto } from "./dto/staff-refund.dto";
import { STAFF_REFUND_NOTICE_MESSAGE, StaffRefundService } from "./staff-refund.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "staff-refund.db.spec.ts";
const NOW_ISO = "2026-11-20T12:00:00.000Z";
const NOW = new Date(NOW_ISO);
const DAY = 24 * 3600 * 1000;

describeDb("R-2 staff refund (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: StaffRefundService;
  let originalSwitch: { value: string } | null = null;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  let seq = 0;
  let actor1: string;
  let actor2: string;
  const savedPauseMode = process.env.BILLING_PAUSE_MODE;

  const body = (over: Partial<StaffRefundDto> = {}): StaffRefundDto => ({
    refundedInFull: true,
    cancelledImmediately: true,
    providerRef: `re_acme_${run}_1`,
    refundDate: "2026-11-18", // 3 days after the fixture payment, 2 days before NOW
    ...over,
  });

  const record = (tenantId: string, over: Partial<YearlyPaymentRecord> = {}) => {
    const r: YearlyPaymentRecord = {
      invoiceId: `in_acme_${run}_${tenantId.slice(0, 6)}`,
      amount: "1188.50",
      currency: "usd",
      paidAt: new Date(NOW.getTime() - 5 * DAY),
      periodStart: new Date(NOW.getTime() - 5 * DAY),
      periodEnd: new Date(NOW.getTime() + 360 * DAY),
      planKey: "GROWTH",
      ...over,
    };
    mockRecords.set(tenantId, r);
    return r;
  };

  async function mkTenant(label: string, status: TenantStatus = TenantStatus.ACTIVE) {
    seq += 1;
    const slug = assertTestTenant(`qa-r2-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status },
    });
    tenantIds.push(t.id);
    return t.id;
  }
  const mkSub = (tenantId: string, extra: Record<string, unknown> = {}) =>
    prisma.tenantSubscription.create({
      data: { tenantId, planKey: "GROWTH", basePriceSnapshot: 249, discount: 0, ...extra } as any,
    });
  /** A tenant with a paying subscription and one ledger row (+249), so every "unchanged" assertion is on a non-zero figure. */
  async function mkPayingTenant(label: string, extra: Record<string, unknown> = {}) {
    const t = await mkTenant(label);
    await mkSub(t, extra);
    await prisma.billingEvent.create({
      data: {
        tenantId: t,
        type: "plan.changed",
        payload: { toPlan: "GROWTH" },
        amountDelta: 249,
        createdAt: new Date(NOW.getTime() - 3 * DAY),
      },
    });
    return t;
  }
  async function mkStaff(label: string) {
    const u = await prisma.user.create({
      data: {
        email: `r2-${run}-${label}@example.test`,
        username: `r2-${run}-${label}`,
        role: "SUPER_ADMIN",
        tenantId: null,
      },
    });
    userIds.push(u.id);
    return u.id;
  }

  const refunds = (tenantId: string) =>
    prisma.billingEvent.findMany({ where: { tenantId, type: "refund.staff" } });
  const sumDelta = async (tenantId: string) =>
    Number(
      (await prisma.billingEvent.aggregate({ _sum: { amountDelta: true }, where: { tenantId } }))
        ._sum.amountDelta ?? 0,
    );
  /**
   * MrrService.computeOverview() is a whole-table rollup that concurrent specs also write into, so a before/after on the raw
   * service would flake. The service itself runs unchanged; only its two billingEvent sums are narrowed to ONE tenant (the
   * PRODUCTION class filter stays), which is the part a refund.staff row could move.
   */
  const mrrOf = async (tenantId: string) => {
    const scoped = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key === "billingEvent") {
          return {
            aggregate: (a: any) =>
              target.billingEvent.aggregate({ ...a, where: { ...a.where, tenantId } }),
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const o = await new MrrService(scoped as any).computeOverview();
    return { ledgerMrr: o.ledgerMrr, momDelta: o.momDelta };
  };
  const catchErr = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a refusal");
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    (prisma as any).forSystem = (_reason: string, fn: (db: unknown) => unknown) => fn(prisma);
    originalSwitch = await prisma.platformConfig.findUnique({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      select: { value: true },
    });
    svc = new StaffRefundService(prisma as any, new BillingEventService(prisma as any));
    actor1 = await mkStaff("a1");
    actor2 = await mkStaff("a2");
  });

  afterAll(async () => {
    jest.useRealTimers();
    if (savedPauseMode === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = savedPauseMode;
    if (prisma) {
      if (originalSwitch) {
        await prisma.platformConfig.upsert({
          where: { key: AUTO_LOCKS_PAUSED_KEY },
          create: { key: AUTO_LOCKS_PAUSED_KEY, value: originalSwitch.value },
          update: { value: originalSwitch.value },
        });
      } else {
        await prisma.platformConfig.deleteMany({ where: { key: AUTO_LOCKS_PAUSED_KEY } });
      }
      if (tenantIds.length) {
        await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  beforeEach(() => {
    pinWallClock(NOW_ISO);
    mockRecords.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("test 10, cross-tenant: only tenant B has a yearly record; a POST against tenant A is NO_YEARLY_PAYMENT and writes nothing for either", async () => {
    const a = await mkPayingTenant("x-a");
    const b = await mkPayingTenant("x-b");
    record(b);
    const e = await catchErr(svc.record(a, body(), actor1));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT });
    expect(await refunds(a)).toHaveLength(0);
    expect(await refunds(b)).toHaveLength(0);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: { in: [a, b] }, action: "TENANT_STAFF_REFUND_RECORDED" },
      }),
    ).toBe(0);
  });

  it("test 9 on a real database: no record (the stub's null) writes no BillingEvent and no AuditLog row", async () => {
    const t = await mkPayingTenant("none");
    const e = await catchErr(svc.record(t, body(), actor1));
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT });
    expect(await refunds(t)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { tenantId: t } })).toBe(0);
  });

  it("test 11, double submit: one row; the second POST is 409 ALREADY_RECORDED carrying the first row's date, reference and actor", async () => {
    const t = await mkPayingTenant("dbl");
    const rec = record(t);
    await svc.record(t, body({ providerRef: "re_first" }), actor1);
    const e = await catchErr(svc.record(t, body({ providerRef: "re_second" }), actor2));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({
      code: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
      providerRef: "re_first",
      refundDate: "2026-11-18",
      actorName: `r2-${run}-a1`,
    });
    const rows = await refunds(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      invoiceId: rec.invoiceId,
      amount: "1188.50",
      providerRef: "re_first",
    });
    // the refundable read now names the existing row
    const view = await svc.resolveRefundable(t);
    expect(view.refusal).toBe(API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED);
    expect(view.existing?.providerRef).toBe("re_first");
  });

  it("test 12, concurrent submit: two POSTs past the unlocked read queue on the tenant row lock; one 201, one 409, one row", async () => {
    const t = await mkPayingTenant("race");
    record(t);
    // Hold the tenant row lock so both POSTs reach it (and block) after their unlocked early reads.
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${t} FOR UPDATE`;
        markLocked();
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    await locked;
    const p1 = svc.record(t, body({ providerRef: "re_race_1" }), actor1);
    const p2 = svc.record(t, body({ providerRef: "re_race_2" }), actor2);
    // the row fails (not passes vacuously) if neither session ever reached the lock
    await waitForBlockedSession(prisma as any);
    release();
    await holder;
    const settled = await Promise.allSettled([p1, p2]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    expect(refused[0].reason.getResponse()).toMatchObject({
      code: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
    });
    expect(await refunds(t)).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: t, action: "TENANT_STAFF_REFUND_RECORDED" },
      }),
    ).toBe(1);
  });

  it("test 13, MRR unchanged: the row's amountDelta is NULL; the tenant's sum, ledgerMrr and the last-30-days delta are equal before and after", async () => {
    const t = await mkPayingTenant("mrr");
    record(t);
    const beforeSum = await sumDelta(t);
    const beforeMrr = await mrrOf(t);
    expect(beforeSum).toBe(249); // not a vacuous zero
    expect(beforeMrr.ledgerMrr).toBe(249);
    expect(beforeMrr.momDelta).toBe(249);

    await svc.record(t, body(), actor1);

    const rows = await refunds(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountDelta).toBeNull();
    expect(await sumDelta(t)).toBe(beforeSum); // the delete true-up's input (platform-admin.service.ts:689)
    expect(await mrrOf(t)).toEqual(beforeMrr);
  });

  it("test 15, export exclusion: getExport never carries the refund.staff row, its reference or its note", async () => {
    const t = await mkPayingTenant("exp");
    record(t);
    await svc.record(
      t,
      body({ providerRef: "re_secret_ref", note: "staff-only note text" }),
      actor1,
    );
    expect(await refunds(t)).toHaveLength(1);
    const exp = new SubscriptionService(prisma as any, {} as any, {} as any, {} as any);
    jest.spyOn(exp, "getSubscription").mockResolvedValue({ planKey: "GROWTH" } as never);
    jest.spyOn(exp, "getUsage").mockResolvedValue([] as never);
    const out = await exp.getExport(t);
    expect(out.billingEvents.map((e) => e.type)).not.toContain("refund.staff");
    expect(out.billingEvents.map((e) => e.type)).toContain("plan.changed"); // the export is not empty
    const json = JSON.stringify(out);
    for (const secret of ["re_secret_ref", "staff-only note text", "refundedInFull"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("test 16, audit: a successful POST writes one AuditLog row with the action, the neutral line and the ids", async () => {
    const t = await mkPayingTenant("aud");
    const rec = record(t);
    await svc.record(t, body({ providerRef: "re_aud" }), actor1);
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: t, action: "TENANT_STAFF_REFUND_RECORDED" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(actor1);
    expect(rows[0].entityType).toBe("tenant");
    expect(rows[0].entityId).toBe(t);
    expect(rows[0].meta).toEqual({
      platformAdmin: true,
      message: STAFF_REFUND_NOTICE_MESSAGE,
      invoiceId: rec.invoiceId,
      providerRef: "re_aud",
      refundDate: "2026-11-18",
    });
  });

  it("the billing-events list reads back newest first with the label and the actor's name, for this tenant only", async () => {
    const t = await mkPayingTenant("list");
    const other = await mkPayingTenant("list-other");
    record(t);
    await svc.record(t, body(), actor1);
    const rows = await svc.listBillingEvents(t);
    expect(rows.every((r) => r.payload !== undefined)).toBe(true);
    expect(rows[0]).toMatchObject({
      type: "refund.staff",
      label: "Staff refund",
      actorName: `r2-${run}-a1`,
    });
    expect(rows.map((r) => r.type)).toEqual(["refund.staff", "plan.changed"]);
    expect(rows.find((r) => r.type === "plan.changed")?.label).toBeNull();
    expect((await svc.listBillingEvents(other)).map((r) => r.type)).toEqual(["plan.changed"]);
  });

  describe("test 18, the rollout pause holds the cancel webhook; the staff refund then changes no tenant state", () => {
    let sw: AutoLockSwitchService;
    let billing: BillingService;
    const stripe: any = {
      isConfigured: true,
      getSubscription: jest.fn(async () => ({ status: "active" })),
      retrieveSubscriptionWithDiscounts: jest
        .fn()
        .mockResolvedValue({ status: "canceled", discounts: [] }),
      previewNextInvoice: jest.fn().mockResolvedValue(null),
      updateSubscription: jest.fn().mockResolvedValue({}),
      listOpenSubscriptionInvoices: jest.fn(async () => []),
    };
    const notifyCancelled = jest.fn().mockResolvedValue(undefined);
    const guard: any = { invalidate: jest.fn() };

    beforeAll(() => {
      sw = new AutoLockSwitchService(prisma as any);
      const events = new BillingEventService(prisma as any);
      const notifications: any = {
        notifyCancelled,
        notifySuspended: jest.fn().mockResolvedValue(undefined),
        notifyDunning: async () => ({ status: "sent", recipients: 1 }),
        recordDunningMilestone: async () => true,
        localDateLabel: async () => "Nov 9, 2099",
      };
      const dunning = new DunningService(prisma as any, stripe, notifications, guard, sw);
      billing = new BillingService(
        prisma as any,
        stripe,
        { send: jest.fn().mockResolvedValue({}) } as any,
        guard,
        events,
        {} as any, // pricing
        notifications,
        { isEnabled: () => Promise.resolve(false) } as any, // planTransition
        {} as any, // mutations
        undefined,
        undefined,
        dunning,
        sw,
      );
    });

    it("autoLockAllowed is false (paused, PRODUCTION): the subscription-deleted webhook leaves the tenant ACTIVE; recording the refund afterwards leaves tenant, subscription and MRR as they were", async () => {
      process.env.BILLING_PAUSE_MODE = "enforced";
      await sw.setPaused(true, "r2 db spec", null);
      sw.invalidate();
      const subId = `sub_${run}_pause`;
      const customerId = `cus_${run}_pause`;
      const t = await mkPayingTenant("pause", { stripeSubId: subId, stripeCustomerId: customerId });
      record(t);

      await billing.handleWebhookEvent({
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subId, customer: customerId } },
      } as any);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).status).toBe("ACTIVE");
      expect(notifyCancelled).not.toHaveBeenCalled();

      const tenantBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
      const subBefore = await prisma.tenantSubscription.findUniqueOrThrow({
        where: { tenantId: t },
      });
      const sumBefore = await sumDelta(t);
      const mrrBefore = await mrrOf(t);

      await svc.record(t, body(), actor1);

      expect(await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).toEqual(tenantBefore);
      expect(await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } })).toEqual(
        subBefore,
      );
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).status).toBe("ACTIVE");
      expect(await sumDelta(t)).toBe(sumBefore);
      expect(await mrrOf(t)).toEqual(mrrBefore);
      const notice = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: t, action: "TENANT_STAFF_REFUND_RECORDED" },
      });
      expect((notice.meta as any).message).toBe(
        "Recorded only; the subscription status here is unchanged until the provider's cancellation is processed.",
      );
    });
  });
});
