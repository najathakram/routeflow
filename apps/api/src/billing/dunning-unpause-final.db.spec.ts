/**
 * Row 412 (SA-775) - a final notice sent BEFORE the rollout pause started counts as NOT sent after the unpause,
 * against real Postgres. What a mock cannot prove: the re-issued final is a REAL second `BillingNotificationLog`
 * claim under the `@@unique(tenantId, milestone, key)` constraint (a key per unpause instant), the sweep's claim
 * lookup finds it, and the tenant is locked only 24 h after it.
 *
 * Scenario: the REAL dated final goes out at T (switch unpaused since T0 < T) -> the switch is paused at T+10 h
 * (the lock is held) -> unpaused at U = T+5 d: the first sweep sends ONE new final and does NOT lock; the lock
 * follows 24 h after the new final. The switch is the real `AutoLockSwitchService` over the real `PlatformConfig`
 * table (its original row is restored); the notification service is the REAL one over a fake mail transport.
 * Sweep time is simulated (`sweep(now)`), so each claim's `sentAt` is stamped to that simulated clock.
 *
 * Throwaway `qa-*` tenants only; the sweeps scan the whole scratch DB, so every Stripe fact for a foreign
 * invoice is "void" (nothing to do) and every assertion is scoped to this run's tenant ids.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingEventService } from "./billing-event.service";
import { BillingNotificationService } from "./billing-notification.service";
import { BillingService } from "./billing.service";
import { DunningService } from "./dunning.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { AUTO_LOCKS_PAUSED_KEY } from "./auto-lock-gate";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "dunning-unpause-final.db.spec.ts";
const H = 3_600_000;
// 2099 keeps every instant far from real data; hour offsets are from the clock start.
const SINCE = new Date("2099-11-01T00:00:00Z");
const at = (h: number) => new Date(SINCE.getTime() + h * H);

describeDb("row 412: a pre-pause final is stale after an unpause (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let sw: AutoLockSwitchService;
  let dunning: DunningService;
  let notifications: BillingNotificationService;
  let originalSwitch: { value: string } | null = null;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const mine = new Set<string>(); // invoice ids of this run
  let seq = 0;
  let clock = SINCE;
  const saved = process.env.BILLING_PAUSE_MODE;
  const mail: { to: string; subject: string }[] = [];
  const guard: any = { invalidate: jest.fn() };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    originalSwitch = await prisma.platformConfig.findUnique({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      select: { value: true },
    });
    sw = new AutoLockSwitchService(prisma as any);
    const email: any = {
      sendPlatform: async (m: { to: string; subject: string }) => {
        mail.push({ to: m.to, subject: m.subject });
        return { delivered: true };
      },
    };
    const real = new BillingNotificationService(prisma as any, email);
    // The real service, but each new claim carries the SIMULATED clock as its sentAt (the column defaults to now()).
    notifications = Object.create(real);
    notifications.notifyDunning = async (...a: Parameters<typeof real.notifyDunning>) => {
      const r = await real.notifyDunning(...a);
      if (r.status === "sent") await stamp(a[0], a[1], a[2]);
      return r;
    };
    notifications.recordDunningMilestone = async (t: string, m: string, k: string) => {
      const won = await real.recordDunningMilestone(t, m, k);
      if (won) await stamp(t, m, k);
      return won;
    };
    const stripe: any = {
      isConfigured: true,
      getInvoiceFacts: jest.fn(async (id: string) =>
        mine.has(id)
          ? {
              status: "open",
              amountPaid: 0,
              amountDue: 14900,
              amountRemaining: 14900,
              paymentProcessing: false,
              nextPaymentAttempt: null,
              attemptCount: 3,
              subscriptionId: null,
              hostedInvoiceUrl: "https://pay.example.test/i/x",
            }
          : { status: "void", amountPaid: 0, amountDue: 0, amountRemaining: 0 },
      ),
      listOpenSubscriptionInvoices: jest.fn(async () => []),
      getSubscription: jest.fn(async () => ({ status: "active" })),
      updateSubscription: jest.fn().mockResolvedValue({}),
    };
    dunning = new DunningService(prisma as any, stripe, notifications, guard, sw);
    // BillingService binds the dunning status transition in its constructor.
    new BillingService(
      prisma as any,
      stripe,
      { send: jest.fn().mockResolvedValue({}) } as any,
      guard,
      new BillingEventService(prisma as any),
      {} as any,
      notifications,
      { isEnabled: () => Promise.resolve(false) } as any,
      {} as any,
      undefined,
      undefined,
      dunning,
      sw,
    );
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
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
      await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mail.length = 0;
    process.env.BILLING_PAUSE_MODE = "enforced";
  });

  async function stamp(tenantId: string, milestone: string, key: string) {
    await prisma.billingNotificationLog.updateMany({
      where: { tenantId, milestone, key },
      data: { sentAt: clock },
    });
  }

  /** Writes the switch row directly so `at` is a simulated instant (the service stamps real time). */
  async function setSwitch(state: "paused" | "unpaused", when: Date, legacyBare = false) {
    const value = legacyBare
      ? "false"
      : JSON.stringify({
          paused: state === "paused",
          reason: "db spec",
          by: null,
          at: when.toISOString(),
        });
    await prisma.platformConfig.upsert({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      create: { key: AUTO_LOCKS_PAUSED_KEY, value },
      update: { value },
    });
    sw.invalidate();
  }

  const sweepAt = async (h: number) => {
    clock = at(h);
    await dunning.sweep(clock);
  };

  /** An overdue PRODUCTION (or other class) tenant whose real final went out at +150 h. */
  async function tenantWithRealFinal(label: string, cls: TenantClass, finalAtH = 150) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa775r412-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: cls, status: TenantStatus.ACTIVE } as any,
    });
    tenantIds.push(t.id);
    await prisma.user.create({
      data: {
        tenantId: t.id,
        email: `admin-${seq}-${run}@example.test`,
        username: `admin-${seq}-${run}`,
        role: "TENANT_ADMIN",
        status: "ACTIVE",
      } as any,
    });
    const invoiceId = `in_${label}_${run}`;
    mine.add(invoiceId);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "GROWTH",
        basePriceSnapshot: 149,
        discount: 0,
        stripeSubId: `sub_${label}_${run}`,
        stripeCustomerId: `cus_${label}_${run}`,
        externalPayment: false,
        pastDueSince: SINCE,
        pastDueInvoiceId: invoiceId,
      } as any,
    });
    const ep = `${invoiceId}:${SINCE.toISOString()}`;
    await prisma.billingNotificationLog.createMany({
      data: [
        { tenantId: t.id, milestone: "DUNNING_D0", key: ep, sentAt: at(0) },
        { tenantId: t.id, milestone: "DUNNING_D3", key: ep, sentAt: at(72) },
        { tenantId: t.id, milestone: "DUNNING_D6", key: ep, sentAt: at(144) },
        { tenantId: t.id, milestone: "DUNNING_FINAL", key: ep, sentAt: at(finalAtH) },
      ],
    });
    return { t: t.id, ep };
  }

  const finals = (t: string) =>
    prisma.billingNotificationLog.findMany({
      where: { tenantId: t, milestone: "DUNNING_FINAL" },
      orderBy: { sentAt: "asc" },
    });
  const tenantRow = (id: string) => prisma.tenant.findUniqueOrThrow({ where: { id } });

  it("PRODUCTION: final -> pause -> unpause sends ONE new final under a new claim key, and locks 24 h after IT", async () => {
    await setSwitch("unpaused", at(100)); // T0 < T
    const d = await tenantWithRealFinal("seq", TenantClass.PRODUCTION);

    await setSwitch("paused", at(160)); // T + 10 h: the lock is held
    await sweepAt(160);
    expect(await finals(d.t)).toHaveLength(1);
    expect((await tenantRow(d.t)).status).toBe("ACTIVE");

    const U = at(270); // T + 5 d
    await setSwitch("unpaused", U);
    await sweepAt(270);
    const afterUnpause = await finals(d.t);
    expect(afterUnpause).toHaveLength(2);
    expect(afterUnpause[1].key).toBe(`${d.ep}:u${U.toISOString()}`);
    expect(afterUnpause[1].sentAt.getTime()).toBe(U.getTime());
    expect(mail.length).toBeGreaterThanOrEqual(1);
    expect((await tenantRow(d.t)).status).toBe("ACTIVE"); // the sweep that re-sent the notice locks nobody
    expect(
      (await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: d.t } })).pausedAt,
    ).toBeNull();

    await sweepAt(271); // idempotent: the claim for this unpause exists
    expect(await finals(d.t)).toHaveLength(2);
    await sweepAt(293); // 23 h after the new final
    expect((await tenantRow(d.t)).status).toBe("ACTIVE");
    await sweepAt(295); // 25 h
    const locked = await tenantRow(d.t);
    expect(locked.status).toBe("READ_ONLY");
    expect(locked.readOnlyReason).toBe("payment_overdue");
    expect(await finals(d.t)).toHaveLength(2);
  });

  it("the unique constraint: the first-final key is taken, the per-unpause key is a distinct second claim, a repeat is skipped", async () => {
    const d = await tenantWithRealFinal("uniq", TenantClass.PRODUCTION);
    const extra = { payUrl: null, readOnlyOn: "Nov 9, 2099", omitLockWarning: false };
    // seeded base claim: a second send under the same key is skipped (no mail)
    expect(
      (await notifications.notifyDunning(d.t, "DUNNING_FINAL", d.ep, "final", extra)).status,
    ).toBe("skipped");
    const key = `${d.ep}:u${at(270).toISOString()}`;
    expect(
      (await notifications.notifyDunning(d.t, "DUNNING_FINAL", key, "final", extra)).status,
    ).toBe("sent");
    expect(
      (await notifications.notifyDunning(d.t, "DUNNING_FINAL", key, "final", extra)).status,
    ).toBe("skipped");
    expect(await finals(d.t)).toHaveLength(2);
  });

  it("a second pause -> unpause re-issues exactly once more, under the key of the new unpause", async () => {
    await setSwitch("unpaused", at(100));
    const d = await tenantWithRealFinal("again", TenantClass.PRODUCTION);
    await setSwitch("unpaused", at(270));
    await sweepAt(270);
    await setSwitch("paused", at(280));
    await sweepAt(280);
    const U2 = at(400);
    await setSwitch("unpaused", U2);
    await sweepAt(400);
    await sweepAt(401);
    const keys = (await finals(d.t)).map((f) => f.key);
    expect(keys).toEqual([
      d.ep,
      `${d.ep}:u${at(270).toISOString()}`,
      `${d.ep}:u${U2.toISOString()}`,
    ]);
    expect((await tenantRow(d.t)).status).toBe("ACTIVE");
    await sweepAt(425);
    expect((await tenantRow(d.t)).status).toBe("READ_ONLY");
  });

  it("a final sent AFTER the unpause is honoured: no resend, locked 24 h after it", async () => {
    await setSwitch("unpaused", at(140));
    const d = await tenantWithRealFinal("after", TenantClass.PRODUCTION, 150);
    await sweepAt(173);
    expect((await tenantRow(d.t)).status).toBe("ACTIVE");
    await sweepAt(175);
    expect((await tenantRow(d.t)).status).toBe("READ_ONLY");
    expect(await finals(d.t)).toHaveLength(1);
  });

  it("TEST class: unchanged - never re-sent, locks 24 h after the old final even after an unpause", async () => {
    await setSwitch("unpaused", at(270));
    const d = await tenantWithRealFinal("test", TenantClass.TEST);
    await sweepAt(295);
    expect(await finals(d.t)).toHaveLength(1);
    expect((await tenantRow(d.t)).status).toBe("READ_ONLY");
  });

  it("a legacy bare 'false' (no `at`): the row's write time is the boundary, so the old final is stale (re-sent)", async () => {
    await setSwitch("unpaused", at(0), true); // the row is written NOW (real clock, far before 2099)
    const d = await tenantWithRealFinal("legacy", TenantClass.PRODUCTION);
    const boundary = await sw.unpausedSince();
    expect(boundary).toBeInstanceOf(Date);
    await sweepAt(270);
    // 2099 sentAt values are all after a real-clock boundary, so the old final is honoured here: nothing re-sent.
    expect(await finals(d.t)).toHaveLength(1);
    // while a boundary AFTER the old final (the same legacy shape written later) makes it stale
    await prisma.platformConfig.update({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      data: { value: "false", updatedAt: at(200) },
    });
    sw.invalidate();
    await sweepAt(272);
    expect(await finals(d.t)).toHaveLength(2);
  });
});
