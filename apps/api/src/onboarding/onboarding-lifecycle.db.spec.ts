/**
 * Real-Postgres pins for the onboarding lifecycle jobs (#2159 S5, plan §6 S5):
 *
 *   - reminders: a quiet OPEN case with a live link and an owed section gets exactly one
 *     reminder per quiet window, never more than REMINDER_MAX_PER_LINK per link, and never the
 *     link itself; nothing is sent when every section is in, when the link is revoked, when the
 *     customer used the link recently, or when the case is ON_HOLD;
 *   - purge: files on a case LIVE for 30+ days lose their stored object and get `purgedAt`
 *     (customer-deleted files too); a case LIVE for less is untouched; a storage failure leaves
 *     the row un-stamped for the next run; a second run is a no-op;
 *   - funnel: signed / paid / live counts and median days per stage for the cohort.
 *
 * Email and storage are mocked at the module boundary. Platform rows carry a
 * `db-spec-onb5-<run>` marker and `afterAll` deletes exactly what this file created.
 */
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { OnboardingService } from "./onboarding.service";
import {
  OnboardingLifecycleService,
  PURGE_AFTER_LIVE_DAYS,
  REMINDER_MAX_PER_LINK,
  REMINDER_QUIET_DAYS,
} from "./onboarding-lifecycle.service";

const RUN = randomUUID().slice(0, 8);
const ADMIN = `db-spec-onb5-admin-${RUN}`;
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

describeDb("onboarding lifecycle jobs (#2159 S5) — real Postgres", () => {
  let prisma: PrismaService;
  let cases: OnboardingService;
  let svc: OnboardingLifecycleService;
  const caseIds: string[] = [];
  const sent: { to: string; subject: string; html: string }[] = [];
  const deleted: string[] = [];
  let failKeys = new Set<string>();

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    const tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    cases = new OnboardingService(prisma, new AuditService(prisma), tenantCtx);
    const email = {
      sendPlatform: jest.fn(async (m: { to: string; subject: string; html: string }) => {
        sent.push(m);
        return { delivered: true, transport: "smtp" as const };
      }),
    };
    const storage = {
      delete: jest.fn(async (key: string) => {
        if (failKeys.has(key)) throw new Error("storage down");
        deleted.push(key);
      }),
    };
    svc = new OnboardingLifecycleService(prisma, email as never, storage as never);
  });

  afterAll(async () => {
    try {
      await prisma.onboardingCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: ADMIN } });
    } finally {
      await prisma?.$disconnect();
    }
  });

  async function newCase(label: string) {
    seq += 1;
    const c = await cases.create(
      {
        companyName: `Acme ${label} ${RUN}-${seq}`,
        contactName: "Pat Example",
        contactEmail: `pat-${RUN}-${seq}@example.invalid`,
      },
      ADMIN,
    );
    caseIds.push(c.id);
    return c.id;
  }

  /** A live link issued `issuedDaysAgo` days before `now`, plus sections in the given states. */
  async function withIntake(
    caseId: string,
    now: Date,
    issuedDaysAgo: number,
    sectionStates: Record<string, string>,
    opts: { revoked?: boolean; lastUsedDaysAgo?: number } = {},
  ) {
    const token = await prisma.intakeAccessToken.create({
      data: {
        caseId,
        tokenHash: `db-spec-onb5-${randomUUID()}`,
        createdAt: new Date(now.getTime() - issuedDaysAgo * DAY),
        expiresAt: new Date(now.getTime() + 20 * DAY),
        revokedAt: opts.revoked ? now : null,
        lastUsedAt:
          opts.lastUsedDaysAgo === undefined
            ? null
            : new Date(now.getTime() - opts.lastUsedDaysAgo * DAY),
        createdById: ADMIN,
      },
    });
    for (const [key, status] of Object.entries(sectionStates)) {
      await prisma.intakeSection.create({
        data: { caseId, key: key as never, schemaVersion: 1, status: status as never },
      });
    }
    return token.id;
  }

  async function remindersFor(caseId: string) {
    return prisma.onboardingEvent.findMany({ where: { caseId, type: "reminder.sent" } });
  }

  it("reminds a quiet case once per window, caps at REMINDER_MAX_PER_LINK, and never sends the link", async () => {
    const t0 = new Date("2030-03-01T15:00:00Z");
    const id = await newCase("quiet");
    const tokenId = await withIntake(id, t0, REMINDER_QUIET_DAYS, {
      ACCOUNT: "SUBMITTED",
      TAX_COMPLIANCE: "DRAFT",
      TEAM: "CHANGES_REQUESTED",
    });
    const before = sent.length;

    await svc.sendReminders(t0);
    expect(await remindersFor(id)).toHaveLength(1);
    const mail = sent.at(-1)!;
    expect(sent.length).toBe(before + 1);
    expect(mail.to).toMatch(/^pat-/);
    expect(mail.html).toContain("Tax &amp; compliance");
    expect(mail.html).toContain("Team");
    expect(mail.html).not.toContain("<li>Account</li>");
    expect(mail.html).not.toMatch(/token=|\/onboarding#|href=/);

    // Same day again: still inside the quiet window → nothing.
    await svc.sendReminders(new Date(t0.getTime() + DAY));
    expect(await remindersFor(id)).toHaveLength(1);

    // Each later window adds one, up to the cap.
    for (let i = 1; i <= REMINDER_MAX_PER_LINK + 2; i++) {
      await svc.sendReminders(new Date(t0.getTime() + i * REMINDER_QUIET_DAYS * DAY));
    }
    const all = await remindersFor(id);
    expect(all).toHaveLength(REMINDER_MAX_PER_LINK);
    expect(all.every((e) => (e.payload as { tokenId: string }).tokenId === tokenId)).toBe(true);
    expect(all.every((e) => e.actorType === "SYSTEM")).toBe(true);
  });

  it("sends nothing when every section is in, the link is revoked, the customer was active, or the case is ON_HOLD", async () => {
    const now = new Date("2030-04-01T15:00:00Z");
    const done = await newCase("done");
    await withIntake(done, now, 10, {
      ACCOUNT: "SUBMITTED",
      TEAM: "APPROVED",
      DATA_FILES: "WAIVED",
    });
    const revoked = await newCase("revoked");
    await withIntake(revoked, now, 10, { ACCOUNT: "EMPTY" }, { revoked: true });
    const active = await newCase("active");
    await withIntake(active, now, 10, { ACCOUNT: "DRAFT" }, { lastUsedDaysAgo: 1 });
    const onHold = await newCase("hold");
    await withIntake(onHold, now, 10, { ACCOUNT: "EMPTY" });
    await cases.update(onHold, { status: "ON_HOLD" }, ADMIN);

    await svc.sendReminders(now);
    for (const id of [done, revoked, active, onHold]) {
      expect(await remindersFor(id)).toHaveLength(0);
    }
  });

  /** Walk a case to LIVE (every required step completed), then backdate `closedAt`. */
  async function liveCase(label: string, liveDaysAgo: number, now: Date) {
    const id = await newCase(label);
    for (;;) {
      const c = await cases.get(id);
      if (c.status === "LIVE") break;
      for (const s of c.steps.filter(
        (x) => x.stage === c.stage && x.required && x.status === "PENDING",
      )) {
        await cases.completeStep(id, s.key, { note: "db-spec" }, ADMIN);
      }
      await cases.advance(id, ADMIN);
    }
    await prisma.onboardingCase.update({
      where: { id },
      data: { closedAt: new Date(now.getTime() - liveDaysAgo * DAY) },
    });
    return id;
  }

  async function file(caseId: string, extra: { deletedAt?: Date } = {}) {
    const key = `onboarding/${caseId}/${randomUUID()}-prices.csv`;
    const f = await prisma.intakeFile.create({
      data: {
        caseId,
        sectionKey: "DATA_FILES",
        kind: "products",
        storageKey: key,
        originalName: "prices.csv",
        contentType: "text/csv",
        sizeBytes: 10,
        sha256: "0".repeat(64),
        containsPii: false,
        uploadedBy: "customer",
        ...extra,
      },
    });
    return f;
  }

  it("purges raw files 30+ days after LIVE (customer-deleted ones too), leaves younger cases alone, retries failures, and is idempotent", async () => {
    const now = new Date("2031-01-15T03:30:00Z");
    const old = await liveCase("old", PURGE_AFTER_LIVE_DAYS + 1, now);
    const young = await liveCase("young", PURGE_AFTER_LIVE_DAYS - 1, now);
    const a = await file(old);
    const b = await file(old, { deletedAt: new Date(now.getTime() - 40 * DAY) });
    const flaky = await file(old);
    const keep = await file(young);
    failKeys = new Set([flaky.storageKey]);

    await svc.purgeIntakeFiles(now);
    const rows = await prisma.intakeFile.findMany({
      where: { id: { in: [a.id, b.id, flaky.id, keep.id] } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)!.purgedAt).toEqual(now);
    expect(byId.get(b.id)!.purgedAt).toEqual(now);
    expect(byId.get(flaky.id)!.purgedAt).toBeNull(); // retried next run
    expect(byId.get(keep.id)!.purgedAt).toBeNull();
    expect(deleted).toEqual(expect.arrayContaining([a.storageKey, b.storageKey]));
    expect(deleted).not.toContain(keep.storageKey);
    const ev = await prisma.onboardingEvent.findMany({
      where: { caseId: old, type: "files.purged" },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ count: 2 });

    // Storage recovers: the next run purges only the one left, and a third run does nothing.
    failKeys = new Set();
    const n = deleted.length;
    await svc.purgeIntakeFiles(now);
    expect(deleted.slice(n)).toEqual([flaky.storageKey]);
    await svc.purgeIntakeFiles(now);
    expect(deleted.length).toBe(n + 1);
  });

  it("funnel: signed / paid / live counts and median days per stage for the cohort window", async () => {
    const from = new Date();
    const live = await liveCase("funnel-live", 0, new Date());
    const early = await newCase("funnel-early");
    const to = new Date(Date.now() + 1000);

    // The DB lane runs serially (jest.db.config maxWorkers 1), so the window holds only these two.
    const f = await svc.funnel(from, to);
    expect(f).toMatchObject({ casesOpened: 2, signed: 0, paid: 1, live: 1, lost: 0 });
    expect(new Set([live, early]).size).toBe(2);
    // The LIVE case left every stage (same-day walk → 0 days); the new one left none.
    for (const s of Object.values(f.stageDays)) expect(s).toEqual({ cases: 1, medianDays: 0 });

    // An empty window reports zeros and null medians.
    const empty = await svc.funnel(new Date("2001-01-01"), new Date("2001-01-02"));
    expect(empty).toMatchObject({ casesOpened: 0, signed: 0, paid: 0, live: 0, lost: 0 });
    expect(empty.stageDays.AGREE).toEqual({ cases: 0, medianDays: null });
  });
});
