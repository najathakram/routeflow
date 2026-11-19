/**
 * Real-Postgres pins for the signup welcome (T8 matrix, T5, W18-W20): who gets the welcome and who does not, each
 * eligibility clause probed by one tenant that fails ONLY that clause, and "once" under two ticks and a parallel pair.
 *
 * Email is mocked at the module boundary (`sendPlatform`), the stop links are a stub (PR-1 registers no provider).
 * Throwaway `qa-journey-<case>-<RUN>` tenants only; `assertTestTenant` runs before every write; `afterAll` deletes
 * exactly what this file created. Every instant is derived from one `NOW` taken once and passed to `run`.
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
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingNotificationService } from "../billing/billing-notification.service";
import { SignupJourneyService } from "./signup-journey.service";
import { JOURNEY_OFF_KEY, type JourneyGate, type JourneyStopLinks } from "./signup-journey";
import { FIRST_RUN_KEY } from "../billing/first-run-marker";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "signup-journey.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;
const RUN = randomUUID().slice(0, 8);
const NOW = new Date(); // taken once; every later instant is NOW +/- an interval and `run` receives it
const GATE: JourneyGate = { welcome: true, since: new Date(NOW.getTime() - 3 * DAY) };
const WIDE_GATE: JourneyGate = { welcome: true, since: new Date(NOW.getTime() - 90 * DAY) };

type Seed = {
  status?: "TRIAL" | "ACTIVE" | "READ_ONLY" | "SUSPENDED" | "CANCELLED";
  cls?: "PRODUCTION" | "DEMO" | "TEST" | "INTERNAL";
  createdDaysAgo?: number;
  trialEndsInDays?: number | null;
  deleted?: boolean;
  marker?: "pending" | "answered" | "closed" | null;
  journeyOff?: boolean;
  caseStatus?: "OPEN" | "ON_HOLD" | "LIVE" | "LOST" | null;
  admin?: "active" | "inactive" | "deleted" | "empty-email" | "none";
};

describeDb("signup welcome: eligibility matrix and once-only claim (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: SignupJourneyService;
  const tenantIds: string[] = [];
  const idOf = new Map<string, string>();
  const slugOf = new Map<string, string>();
  const mails: { to: string; subject: string; html: string; text: string }[] = [];
  const stopLinks: JourneyStopLinks = {
    stopUrl: (tenantId, webUrl) => `${webUrl}/email-stop#t=stub-${tenantId}`,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    (prisma as any).forSystem = (_reason: string, fn: (db: unknown) => unknown) => fn(prisma);
    const email = {
      sendPlatform: jest.fn(
        async (m: { to: string; subject: string; html: string; text: string }) => {
          mails.push(m);
          return { delivered: true, transport: "smtp" as const };
        },
      ),
    };
    const notifications = new BillingNotificationService(prisma as any, email as any);
    const config = { get: (k: string) => (k === "WEB_URL" ? "https://app.test" : undefined) };
    svc = new SignupJourneyService(prisma as any, notifications, config as any, stopLinks);
  });

  afterAll(async () => {
    try {
      if (tenantIds.length) {
        await prisma.onboardingCase.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.systemConfig.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  async function mk(label: string, o: Seed = {}): Promise<string> {
    const slug = assertTestTenant(`qa-journey-${label}-${RUN}`, SPEC);
    const trialEnds = o.trialEndsInDays === undefined ? 10 : o.trialEndsInDays; // null = a TRIAL with no end date
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: `Acme ${label}`,
        status: o.status ?? "TRIAL",
        class: o.cls ?? "PRODUCTION",
        createdAt: new Date(NOW.getTime() - (o.createdDaysAgo ?? 1) * DAY),
        trialEndsAt: trialEnds === null ? null : new Date(NOW.getTime() + trialEnds * DAY),
        deletedAt: o.deleted ? new Date(NOW.getTime() - DAY) : null,
      } as any,
    });
    tenantIds.push(t.id);
    idOf.set(label, t.id);
    slugOf.set(label, slug);
    const marker = o.marker === undefined ? "pending" : o.marker;
    if (marker) {
      await prisma.systemConfig.create({
        data: { tenantId: t.id, key: FIRST_RUN_KEY, value: marker },
      });
    }
    if (o.journeyOff) {
      await prisma.systemConfig.create({
        data: { tenantId: t.id, key: JOURNEY_OFF_KEY, value: "1" },
      });
    }
    const admin = o.admin ?? "active";
    if (admin !== "none") {
      await prisma.user.create({
        data: {
          tenantId: t.id,
          email: admin === "empty-email" ? "" : `admin-${slug}@example.invalid`,
          username: `admin-${label}`,
          role: "TENANT_ADMIN",
          status: admin === "inactive" ? "INACTIVE" : "ACTIVE",
          deletedAt: admin === "deleted" ? new Date(NOW.getTime() - DAY) : null,
        } as any,
      });
    }
    if (o.caseStatus) {
      await prisma.onboardingCase.create({
        data: {
          tenantId: t.id,
          companyName: `Acme ${label} ${RUN}`,
          contactName: "Pat Example",
          contactEmail: `pat-${slug}@example.invalid`,
          catalogVersion: 1,
          createdById: `qa-journey-spec-${RUN}`,
          status: o.caseStatus,
        } as any,
      });
    }
    return t.id;
  }

  const claims = (label: string) =>
    prisma.billingNotificationLog.count({
      where: { tenantId: idOf.get(label), milestone: "onboarding.welcome" },
    });
  const mailsTo = (label: string) =>
    mails.filter((m) => m.to === `admin-${slugOf.get(label)}@example.invalid`);

  it("assertTestTenant refuses the old acme-journey slugs (W18)", () => {
    expect(() => assertTestTenant("acme-journey-x", SPEC)).toThrow(/not an approved test tenant/);
    expect(assertTestTenant(`qa-journey-x-${RUN}`, SPEC)).toBe(`qa-journey-x-${RUN}`);
  });

  describe("the matrix: one tick over every row (W20)", () => {
    const WELCOMED: [string, Seed][] = [
      ["trial", {}],
      ["active", { status: "ACTIVE", trialEndsInDays: null }],
      ["case-lost", { caseStatus: "LOST" }],
      ["marker-pending", { marker: "pending" }],
      ["marker-answered", { marker: "answered" }],
      ["marker-closed", { marker: "closed" }],
      ["before-since-wide", { createdDaysAgo: 5 }], // excluded by the first gate, welcomed by the wide second
    ];
    const NOT_WELCOMED: [string, Seed][] = [
      ["case-open", { caseStatus: "OPEN" }],
      ["case-on-hold", { caseStatus: "ON_HOLD" }],
      ["case-live", { caseStatus: "LIVE" }],
      ["admin-inactive", { admin: "inactive" }],
      ["admin-deleted", { admin: "deleted" }],
      ["admin-empty-email", { admin: "empty-email" }],
      ["admin-none", { admin: "none" }],
      ["read-only", { status: "READ_ONLY", trialEndsInDays: null }],
      ["suspended", { status: "SUSPENDED", trialEndsInDays: null }],
      ["cancelled", { status: "CANCELLED", trialEndsInDays: null }],
      ["trial-past-end", { trialEndsInDays: -1 }],
      ["trial-no-end", { trialEndsInDays: null }],
      ["class-demo", { cls: "DEMO" }],
      ["class-test", { cls: "TEST" }],
      ["class-internal", { cls: "INTERNAL" }],
      ["deleted", { deleted: true }],
      ["older-30d", { createdDaysAgo: 40 }],
      ["journey-off", { journeyOff: true }],
      ["no-marker", { marker: null }],
    ];

    beforeAll(async () => {
      for (const [label, seed] of [...WELCOMED, ...NOT_WELCOMED]) await mk(label, seed);
    });

    it("the first tick welcomes exactly the eligible rows, once each, to the admin only", async () => {
      const out = await svc.run(NOW, GATE);
      for (const [label] of WELCOMED.filter(([l]) => l !== "before-since-wide")) {
        expect([label, await claims(label)]).toEqual([label, 1]);
        const sent = mailsTo(label);
        expect([label, sent.length]).toEqual([label, 1]);
        expect(sent[0].subject).toBe(`Welcome to RouteFlow, Acme ${label}`);
        expect(sent[0].html).toContain(
          `href="https://app.test/email-stop#t=stub-${idOf.get(label)}"`,
        );
        expect(sent[0].html).toContain(`Workspace ID: <strong>${slugOf.get(label)}</strong>`);
      }
      for (const [label] of [...NOT_WELCOMED, ["before-since-wide", {}] as [string, Seed]]) {
        expect([label, await claims(label)]).toEqual([label, 0]);
        expect([label, mailsTo(label).length]).toEqual([label, 0]);
      }
      expect(out.sent).toBe(WELCOMED.length - 1);
      expect(out.failed).toBe(0);
    });

    it("a second tick sends nothing new, and the welcome row count stays one", async () => {
      const before = mails.length;
      const out = await svc.run(NOW, GATE);
      expect(mails.length).toBe(before);
      expect(out.sent).toBe(0);
      for (const [label] of WELCOMED.filter(([l]) => l !== "before-since-wide")) {
        expect([label, await claims(label)]).toEqual([label, 1]);
      }
    });

    it("widening since welcomes the 5-day-old row, and still never the 40-day-old one (window cap)", async () => {
      const out = await svc.run(NOW, WIDE_GATE);
      expect(await claims("before-since-wide")).toBe(1);
      expect(await claims("older-30d")).toBe(0);
      expect(out.sent).toBe(1);
    });
  });

  it("two ticks at once give one welcome row and one mail (a parallel pair)", async () => {
    await mk("parallel");
    const before = mailsTo("parallel").length;
    const [a, b] = await Promise.all([svc.run(NOW, GATE), svc.run(NOW, GATE)]);
    expect(await claims("parallel")).toBe(1);
    expect(mailsTo("parallel").length - before).toBe(1);
    expect(a.sent + b.sent).toBe(1);
  });

  it("a stopped business (journeyOff written after sign-up, before the tick) is never welcomed", async () => {
    const id = await mk("stopped-late");
    await prisma.systemConfig.create({ data: { tenantId: id, key: JOURNEY_OFF_KEY, value: "1" } });
    await svc.run(NOW, GATE);
    expect(await claims("stopped-late")).toBe(0);
  });
});
