// `@LeaderCron` wraps every cron tick in a Postgres advisory lock; these specs call the tick body
// directly with no database, so the lock is a pass-through (see authorization-expiry.service.spec).
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test } from "@nestjs/testing";
import { AuthorizationGuardService } from "./authorization-guard.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { AuthorizationExpiryService } from "./authorization-expiry.service";
import { AuthorizationsService } from "./authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { AuditService } from "../audit/audit.service";
import { MessagingService } from "../messaging/messaging.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B330 / REG-LICENCE-DAY: a licence is valid through the END of its printed expiry day in the
 * tenant's time zone, and expired from the first instant of the next day there. The guard, the
 * expiry sweep, the buyer list and the expiry bell must all give the same answer at the same instant.
 * The stored value is the printed calendar day as UTC midnight (the house calendar-date convention).
 */
interface Case {
  name: string;
  zone: string | null; // null = the tenant has no TenantConfig row (UTC fallback)
  printed: string; // the printed expiry day, "YYYY-MM-DD"
  now: string; // the instant we ask at
  expired: boolean;
}

const CHI = "America/Chicago";
const CASES: Case[] = [
  // Chicago, CDT (UTC-5): local midnight ending 2026-03-09 is 2026-03-10T05:00Z.
  {
    name: "Chicago: evening of the printed day is still valid",
    zone: CHI,
    printed: "2026-03-09",
    now: "2026-03-10T03:00:00.000Z",
    expired: false,
  },
  {
    name: "Chicago: 1 ms before local midnight is valid",
    zone: CHI,
    printed: "2026-03-09",
    now: "2026-03-10T04:59:59.999Z",
    expired: false,
  },
  {
    name: "Chicago: the first instant of the next local day is expired",
    zone: CHI,
    printed: "2026-03-09",
    now: "2026-03-10T05:00:00.000Z",
    expired: true,
  },
  {
    name: "Chicago: the first instant of the printed day is valid",
    zone: CHI,
    printed: "2026-03-09",
    now: "2026-03-09T05:00:00.000Z",
    expired: false,
  },
  // DST spring-forward (2026-03-08, a 23-hour day): the day ends at 05:00Z, not 06:00Z.
  {
    name: "Chicago spring-forward day: 1 ms before local midnight is valid",
    zone: CHI,
    printed: "2026-03-08",
    now: "2026-03-09T04:59:59.999Z",
    expired: false,
  },
  {
    name: "Chicago spring-forward day: 30 min after local midnight is expired",
    zone: CHI,
    printed: "2026-03-08",
    now: "2026-03-09T05:30:00.000Z",
    expired: true,
  },
  // DST fall-back (2026-11-01, a 25-hour day): the day ends at 06:00Z, not 05:00Z.
  {
    name: "Chicago fall-back day: 23:30 local on the printed day is valid",
    zone: CHI,
    printed: "2026-11-01",
    now: "2026-11-02T05:30:00.000Z",
    expired: false,
  },
  {
    name: "Chicago fall-back day: the first instant of the next local day is expired",
    zone: CHI,
    printed: "2026-11-01",
    now: "2026-11-02T06:00:00.000Z",
    expired: true,
  },
  // East of UTC (JST, UTC+9): the printed day ends at 15:00Z.
  {
    name: "Tokyo: late afternoon UTC on the printed day is valid",
    zone: "Asia/Tokyo",
    printed: "2026-03-09",
    now: "2026-03-09T10:00:00.000Z",
    expired: false,
  },
  {
    name: "Tokyo: 1 ms before local midnight is valid",
    zone: "Asia/Tokyo",
    printed: "2026-03-09",
    now: "2026-03-09T14:59:59.999Z",
    expired: false,
  },
  {
    name: "Tokyo: the first instant of the next local day is expired",
    zone: "Asia/Tokyo",
    printed: "2026-03-09",
    now: "2026-03-09T15:00:00.000Z",
    expired: true,
  },
  // No TenantConfig row: UTC, the same fallback as every other calendar-day rule.
  {
    name: "UTC fallback: 1 ms before UTC midnight is valid",
    zone: null,
    printed: "2026-03-09",
    now: "2026-03-09T23:59:59.999Z",
    expired: false,
  },
  {
    name: "UTC fallback: UTC midnight of the next day is expired",
    zone: null,
    printed: "2026-03-09",
    now: "2026-03-10T00:00:00.000Z",
    expired: true,
  },
];

describe.each(CASES)("REG-LICENCE-DAY $name", (c) => {
  let prisma: ReturnType<typeof createMockPrisma>;
  const stored = () => new Date(`${c.printed}T00:00:00.000Z`);

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue(c.zone ? { timezone: c.zone } : null);
  });
  afterEach(() => jest.useRealTimers());

  it("the sale guard", async () => {
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationGuardService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AuthorizationOverridesService,
          useValue: { isOverrideActive: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();
    const guard = mod.get(AuthorizationGuardService);
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      status: "VERIFIED",
      expiresAt: stored(),
    });
    jest.useFakeTimers().setSystemTime(new Date(c.now));
    const { blocked } = await guard.checkAuthorized({
      customerId: "c1",
      lines: [{ trackedCategoryId: "cat" }],
    });
    expect(blocked.length > 0).toBe(c.expired);
    if (c.expired) expect(blocked[0]).toMatchObject({ reason: "EXPIRED" });
  });

  it("the buyer list and the expiry bell", async () => {
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: {} },
        { provide: EmailService, useValue: {} },
      ],
    }).compile();
    const svc = mod.get(AuthorizationsService);
    const now = new Date(c.now);
    prisma.trackedCategory.findMany.mockResolvedValue([{ id: "cat", name: "Alcohol" }]);
    prisma.customerAuthorization.findMany.mockResolvedValue([
      {
        id: "a1",
        customerId: "c1",
        trackedCategoryId: "cat",
        status: "VERIFIED",
        expiresAt: stored(),
        customer: { businessName: "Acme" },
        trackedCategory: { name: "Alcohol" },
      },
    ] as never);
    const list = await svc.listForBuyer("c1", now);
    expect(list[0].status).toBe(c.expired ? "EXPIRED" : "VERIFIED");
    const bell = await svc.findExpiringSoon(30, now);
    expect(bell[0].expired).toBe(c.expired);
  });

  it("the expiry sweep flips the row at the same instant", async () => {
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationExpiryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: (_id: string, fn: () => unknown) => fn() },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(undefined),
            sendToUser: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn(), notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    const sweep = mod.get(AuthorizationExpiryService);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({ businessName: "Acme" });
    const row = {
      id: "a1",
      customerId: "c1",
      trackedCategoryId: "cat",
      status: "VERIFIED",
      expiresAt: stored(),
      expiringSoonNotifiedBucket: null,
      customer: { deletedAt: null },
      trackedCategory: { name: "Alcohol", requiresLicense: true },
    };
    // Honest stand-in for Postgres: applies the expiresAt window the service actually sends.
    prisma.customerAuthorization.findMany.mockImplementation((async (args: {
      where?: { expiresAt?: { lt?: Date; gte?: Date } };
    }) => {
      const w = args?.where?.expiresAt ?? {};
      const t = row.expiresAt.getTime();
      if (w.lt !== undefined && !(t < new Date(w.lt).getTime())) return [];
      if (w.gte !== undefined && !(t >= new Date(w.gte).getTime())) return [];
      return [row];
    }) as never);
    prisma.customerAuthorization.count.mockResolvedValue(0);
    const r = await sweep.processTenant("t1", new Date(c.now));
    expect(r.expired).toBe(c.expired ? 1 : 0);
  });
});
