// The leader lock is a Postgres advisory lock; a unit tick runs its body as the lock holder.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BillingNotificationService } from "../billing/billing-notification.service";
import { ACCOUNT_ADMIN_WHERE } from "../billing/account-admins";
import { PrismaService } from "../prisma/prisma.service";
import {
  JOURNEY_BATCH,
  JOURNEY_GATE_CLOSED,
  JOURNEY_STOP_LINKS,
  eligibleTenantWhere,
  type JourneyGate,
  type JourneyStopLinks,
} from "./signup-journey";
import { SignupJourneyService } from "./signup-journey.service";

const DAY = 24 * 60 * 60 * 1000;
// Every instant is derived from this one `now`, which is passed in (L-353).
const NOW = new Date(Date.UTC(2026, 10, 20, 12, 0, 0));
const OPEN: JourneyGate = { welcome: true, since: new Date(NOW.getTime() - 2 * DAY) };
const stopLinks: JourneyStopLinks = {
  stopUrl: (tenantId, webUrl) => `${webUrl}/email-stop#t=tok-${tenantId}`,
};

type Row = { id: string; slug: string };

async function build(
  opts: {
    rows?: Row[];
    webUrl?: string | undefined;
    links?: JourneyStopLinks | null;
    sendOnce?: jest.Mock;
  } = {},
) {
  const findMany = jest.fn().mockResolvedValue(opts.rows ?? [{ id: "t1", slug: "acme-supply" }]);
  const prisma = {
    tenant: { findMany },
    forSystem: jest.fn((_reason: string, fn: () => unknown) => fn()),
  };
  const sendOnceToAdmins =
    opts.sendOnce ?? jest.fn().mockResolvedValue({ status: "sent", recipients: 1 });
  const webUrl = "webUrl" in opts ? opts.webUrl : "https://app.test";
  const providers: any[] = [
    SignupJourneyService,
    { provide: PrismaService, useValue: prisma },
    { provide: BillingNotificationService, useValue: { sendOnceToAdmins } },
    {
      provide: ConfigService,
      useValue: { get: (k: string) => (k === "WEB_URL" ? webUrl : undefined) },
    },
  ];
  if (opts.links !== null) {
    providers.push({ provide: JOURNEY_STOP_LINKS, useValue: opts.links ?? stopLinks });
  }
  const mod = await Test.createTestingModule({ providers }).compile();
  return { svc: mod.get(SignupJourneyService), findMany, sendOnceToAdmins, prisma };
}

describe("SignupJourneyService.runCron: PR-1 cannot send (T11a, W1)", () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it("with the switch names set in the environment, never queries and never claims", async () => {
    process.env.SIGNUP_JOURNEY_EMAILS = "on";
    process.env.SIGNUP_JOURNEY_SINCE = "2026-01-01";
    process.env.SIGNUP_JOURNEY_NUDGES = "on";
    process.env.SIGNUP_JOURNEY_NUDGES_SINCE = "2026-01-01";
    const { svc, findMany, sendOnceToAdmins } = await build();
    await svc.runCron();
    expect(findMany).not.toHaveBeenCalled();
    expect(sendOnceToAdmins).not.toHaveBeenCalled();
  });

  it("with no stop-link provider registered, run(now, openGate) is skipped before any query", async () => {
    const { svc, findMany, sendOnceToAdmins } = await build({ links: null });
    await expect(svc.run(NOW, OPEN)).resolves.toEqual({ sent: 0, skipped: "no-stop-link" });
    expect(findMany).not.toHaveBeenCalled();
    expect(sendOnceToAdmins).not.toHaveBeenCalled();
  });

  it("runs under forSystem with a literal reason, and passes the closed gate", async () => {
    const { svc, prisma } = await build();
    const run = jest.spyOn(svc, "run");
    await svc.runCron();
    expect(prisma.forSystem).toHaveBeenCalledWith(
      "onboarding: signup journey across businesses",
      expect.any(Function),
    );
    expect(run).toHaveBeenCalledWith(expect.any(Date), JOURNEY_GATE_CLOSED);
  });

  it("a closed gate is skipped before any query, even with a stop-link provider", async () => {
    const { svc, findMany } = await build();
    await expect(svc.run(NOW, JOURNEY_GATE_CLOSED)).resolves.toEqual({
      sent: 0,
      skipped: "gate-closed",
    });
    await expect(svc.run(NOW, { welcome: true, since: null })).resolves.toMatchObject({
      skipped: "gate-closed",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("WEB_URL unset: skipped no-stop-link, no query, no claim, no fallback host", async () => {
    const { svc, findMany, sendOnceToAdmins } = await build({ webUrl: undefined });
    await expect(svc.run(NOW, OPEN)).resolves.toEqual({ sent: 0, skipped: "no-stop-link" });
    expect(findMany).not.toHaveBeenCalled();
    expect(sendOnceToAdmins).not.toHaveBeenCalled();
  });
});

describe("SignupJourneyService.run: the welcome path (T5, T5a, T17a)", () => {
  it("queries with the pure eligibility where, newest first, one batch (T5, T17a)", async () => {
    const { svc, findMany } = await build();
    await svc.run(NOW, OPEN);
    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual(eligibleTenantWhere(NOW, OPEN.since as Date));
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.take).toBe(JOURNEY_BATCH);
    // the welcome exclusion rides in the where, so finished tenants never fill the batch
    expect(JSON.stringify(arg.where)).toContain(
      '"billingNotificationLogs":{"none":{"milestone":"onboarding.welcome"}}',
    );
  });

  it("the admin clause handed to tenant.findMany is the exported object itself (T5a, W9)", async () => {
    const { svc, findMany } = await build();
    await svc.run(NOW, OPEN);
    const clause = (findMany.mock.calls[0][0].where.AND as any[]).find((c) => c.users);
    expect(clause.users.some).toBe(ACCOUNT_ADMIN_WHERE);
  });

  it("claims through the one door with the welcome milestone and the empty key", async () => {
    const { svc, sendOnceToAdmins } = await build({
      rows: [
        { id: "t1", slug: "acme-supply" },
        { id: "t2", slug: "acme-two" },
      ],
    });
    const out = await svc.run(NOW, OPEN);
    expect(out).toEqual({ sent: 2, failed: 0, considered: 2 });
    expect(sendOnceToAdmins).toHaveBeenCalledTimes(2);
    expect(sendOnceToAdmins).toHaveBeenNthCalledWith(
      1,
      "t1",
      "onboarding.welcome",
      "",
      expect.any(Function),
    );
    const mail = sendOnceToAdmins.mock.calls[1][3](
      { email: "a@acme.test", name: "A" },
      "Acme Two",
      () => "",
    );
    expect(mail.subject).toBe("Welcome to RouteFlow, Acme Two");
    expect(mail.html).toContain('href="https://app.test/email-stop#t=tok-t2"');
    expect(mail.html).toContain("Workspace ID: <strong>acme-two</strong>");
    expect(mail.replyTo).toBeUndefined();
  });

  it("counts a lost claim as neither sent nor failed, and one throwing tenant never stops the rest", async () => {
    const sendOnce = jest
      .fn()
      .mockResolvedValueOnce({ status: "skipped", recipients: 0 })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "failed", recipients: 0 })
      .mockResolvedValueOnce({ status: "sent", recipients: 2 });
    const { svc } = await build({
      sendOnce,
      rows: ["a", "b", "c", "d"].map((id) => ({ id, slug: `acme-${id}` })),
    });
    await expect(svc.run(NOW, OPEN)).resolves.toEqual({ sent: 1, failed: 2, considered: 4 });
  });

  it("warns when the batch is full", async () => {
    const rows = Array.from({ length: JOURNEY_BATCH }, (_v, i) => ({
      id: `t${i}`,
      slug: `acme-${i}`,
    }));
    const { svc } = await build({ rows });
    const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
    await svc.run(NOW, OPEN);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("batch"));
  });
});

describe("the journey sends only through the claim door (T5, W15)", () => {
  it("a real BillingNotificationService: one mail per admin, a second run sends nothing, no other send path", async () => {
    const seen = new Set<string>();
    const create = jest.fn(
      async (a: { data: { tenantId: string; milestone: string; key: string } }) => {
        const k = `${a.data.tenantId}/${a.data.milestone}/${a.data.key}`;
        if (seen.has(k)) throw Object.assign(new Error("dup"), { code: "P2002" });
        seen.add(k);
        return {};
      },
    );
    const prisma: any = {
      billingNotificationLog: { create, delete: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([{ email: "a@acme.test", username: "A" }]) },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: "Acme Supply", slug: "acme-supply" }),
        findMany: jest.fn().mockResolvedValue([{ id: "t1", slug: "acme-supply" }]),
      },
      tenantConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      forSystem: (_r: string, fn: () => unknown) => fn(),
    };
    const touched: string[] = [];
    const email: any = new Proxy(
      { sendPlatform: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) },
      { get: (t: any, k: string) => (touched.push(String(k)), t[k]) },
    );
    const notifications = new BillingNotificationService(prisma, email);
    const mod = await Test.createTestingModule({
      providers: [
        SignupJourneyService,
        { provide: PrismaService, useValue: prisma },
        { provide: BillingNotificationService, useValue: notifications },
        { provide: ConfigService, useValue: { get: () => "https://app.test" } },
        { provide: JOURNEY_STOP_LINKS, useValue: stopLinks },
      ],
    }).compile();
    const svc = mod.get(SignupJourneyService);
    await svc.run(NOW, OPEN);
    await svc.run(NOW, OPEN);
    expect(email.sendPlatform).toHaveBeenCalledTimes(1);
    expect(email.sendPlatform.mock.calls[0][0].to).toBe("a@acme.test");
    expect(new Set(touched)).toEqual(new Set(["sendPlatform"]));
  });
});
