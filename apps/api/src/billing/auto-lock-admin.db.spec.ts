/**
 * SA-775 (row 381) - the super-admin side of the automatic-lock pause, against real Postgres:
 *   - the UNPAUSE PREVIEW lists the PRODUCTION tenants the crons would lock, and writes NOTHING
 *     (row counts of every table it could touch are identical before and after);
 *   - it never lists a TEST / DEMO / INTERNAL tenant (those keep locking while paused);
 *   - unpause -> the next cron pass locks exactly the previewed tenants;
 *   - the preview and the cron select with the SAME predicates (one builder, L-167);
 *   - the held-lock list reads the durable skip records.
 *
 * Throwaway `qa-*` tenants only, `Tenant.class` set explicitly. The sweeps scan the whole scratch DB, so every
 * assertion is scoped to this run's tenant ids. The switch's original PlatformConfig row is restored afterwards.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingCronService } from "./billing-cron.service";
import { BillingEventService } from "./billing-event.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { AutoLockAdminService } from "./auto-lock-admin.service";
import { AUTO_LOCKS_PAUSED_KEY } from "./auto-lock-gate";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "auto-lock-admin.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb("SA-775 unpause preview + held-lock list (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let sw: AutoLockSwitchService;
  let admin: AutoLockAdminService;
  let cron: BillingCronService;
  let originalSwitch: { value: string } | null = null;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const noop: any = { invalidate: jest.fn() };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    originalSwitch = await prisma.platformConfig.findUnique({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      select: { value: true },
    });
    sw = new AutoLockSwitchService(prisma as any);
    admin = new AutoLockAdminService(prisma as any, sw);
    cron = new BillingCronService(
      prisma as any,
      new BillingEventService(prisma as any),
      noop,
      noop,
      {} as any,
      {} as any,
      { notifyTrialEnding: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
      {} as any,
      sw,
    );
  });

  afterAll(async () => {
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
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function mkTenant(label: string, cls: TenantClass, status: TenantStatus, extra = {}) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa775a-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: cls, status, ...extra } as any,
    });
    tenantIds.push(t.id);
    return t.id;
  }

  /** Row counts of every table the preview or the skip record could touch. */
  const footprint = async () => ({
    tenants: await prisma.tenant.count(),
    subs: await prisma.tenantSubscription.count(),
    addons: await prisma.tenantAddon.count(),
    events: await prisma.billingEvent.count(),
    claims: await prisma.billingNotificationLog.count(),
    audits: await prisma.auditLog.count(),
    config: await prisma.platformConfig.count(),
  });

  it("the preview lists the due PRODUCTION tenants only, is read-only, and the next cron pass locks exactly them", async () => {
    await sw.setPaused(true, "db spec", null);
    const dueTrial = await mkTenant("trial", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
      trialEndsAt: new Date(Date.now() - 2 * DAY),
    });
    const dueCancel = await mkTenant("cancel", TenantClass.PRODUCTION, TenantStatus.ACTIVE);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: dueCancel,
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        cancelAtPeriodEnd: true,
        periodEnd: new Date(Date.now() - DAY),
      } as any,
    });
    const notDueTrial = await mkTenant("trial-future", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
      trialEndsAt: new Date(Date.now() + 9 * DAY),
    });
    const testTrial = await mkTenant("trial-test", TenantClass.TEST, TenantStatus.TRIAL, {
      trialEndsAt: new Date(Date.now() - 2 * DAY),
    });
    const demoTrial = await mkTenant("trial-demo", TenantClass.DEMO, TenantStatus.TRIAL, {
      trialEndsAt: new Date(Date.now() - 2 * DAY),
    });
    const mine = new Set([dueTrial, dueCancel, notDueTrial, testTrial, demoTrial]);

    const before = await footprint();
    const preview = await admin.preview();
    const state = await admin.getState();
    expect(await footprint()).toEqual(before); // read-only: nothing written to produce either answer

    const listed = (rows: { tenantId: string; kind: string }[]) =>
      rows
        .filter((r) => mine.has(r.tenantId))
        .map((r) => `${r.tenantId}:${r.kind}`)
        .sort();
    const expected = [`${dueTrial}:trial_expired`, `${dueCancel}:subscription_cancelled`].sort();
    expect(preview.paused).toBe(true);
    expect(listed(preview.wouldLock)).toEqual(expected);
    expect(listed(state.wouldLockNow)).toEqual(expected);

    // the cron, once unpaused, locks exactly what the preview promised (and no TEST/DEMO row is "new": those
    // already lock while paused - run one pass first to prove it, then unpause for PRODUCTION)
    await cron.expireTrials();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: testTrial } })).status).toBe(
      "READ_ONLY",
    );
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: dueTrial } })).status).toBe(
      "TRIAL",
    );

    await sw.setPaused(false, "db spec unpause", "sa-1");
    await cron.expireTrials();
    await cron.applyScheduledCancellations();
    const status = async (id: string) =>
      (await prisma.tenant.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(dueTrial)).toBe("READ_ONLY");
    expect(await status(dueCancel)).toBe("READ_ONLY");
    expect(await status(notDueTrial)).toBe("TRIAL"); // not previewed, not locked

    // after the locks, the preview no longer lists them
    const after = await admin.preview();
    expect(listed(after.wouldLock)).toEqual([]);
  });

  it("the held-lock list reads the durable skip records (kind decoded, newest first)", async () => {
    await sw.setPaused(true, "db spec", null);
    const t = await mkTenant("held", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
      trialEndsAt: new Date(Date.now() - 3 * DAY),
    });
    await cron.expireTrials();
    await cron.expireTrials();
    const held = (await admin.skipped()).filter((r) => r.tenantId === t);
    expect(held).toHaveLength(1);
    expect(held[0].kind).toBe("trial_expired");
    expect(held[0].at).toBeInstanceOf(Date);
  });

  it("setPaused returns the previous state and writes the key (JSON) that isPaused reads back", async () => {
    await sw.setPaused(false, "first", "sa-1");
    const res = await admin.setPaused(true, "second", "sa-1");
    expect(res.previous.paused).toBe(false);
    expect(res.previous.reason).toBe("first");
    expect(res.paused).toBe(true);
    expect(await sw.isPaused()).toBe(true);
  });
});
