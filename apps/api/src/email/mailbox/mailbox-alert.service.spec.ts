/**
 * F-10a (#2077) — who hears about an automatic mailbox state change, through which channel, and
 * what they are told. REVOKED: an in-app notification to every active tenant admin AND an email
 * through the PLATFORM sender (never the dead mailbox). THROTTLED: in-app only. The copy says what
 * happened, where the tenant's email goes meanwhile, and how to fix it. Never throws.
 */
import * as fs from "fs";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { EncryptionService } from "../../common/encryption.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { MailboxAlertService } from "./mailbox-alert.service";
import {
  MAILBOX_ALERT_DELIVERY_DEADLINE_MS,
  MAILBOX_ALERT_LEASE_MS,
  MAILBOX_ALERT_SWEEP_EVERY_MIN,
} from "./mailbox-alert-outbox";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";

jest.mock("axios");
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

function change(over: Partial<MailboxStateChange> = {}): MailboxStateChange {
  return {
    tenantId: "tenant-a",
    connectionId: "mc-1",
    provider: "GOOGLE",
    accountEmail: "sales@acme.test",
    status: "REVOKED",
    reasonCode: "google_invalid_grant",
    throttledUntil: null,
    alertPendingAt: PENDING_AT,
    ...over,
  };
}

/** #2113: the value the transition committed; the stubbed CAS matches it. */
const PENDING_AT = new Date("2026-09-28T00:00:00.000Z");

/** The row a claim reads back — by default, the state the change describes. */
const rowFor = (c: MailboxStateChange) => ({
  tenantId: c.tenantId,
  provider: c.provider,
  accountEmail: c.accountEmail,
  status: c.status,
  throttledUntil: c.throttledUntil,
});

const ADMINS = [
  { id: "u-owner", email: "owner@acme.test", username: "owner" },
  { id: "u-partner", email: "partner@acme.test", username: "partner" },
];

function build(opts: { admins?: typeof ADMINS; hasFallback?: boolean } = {}) {
  const tenantCtx = new TenantContextService();
  const tenantSeenBy: string[] = [];
  let current = rowFor(change());
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue(opts.admins ?? ADMINS) },
    // #2113: claim/clear CAS both win by default; the claimed row mirrors the change notified.
    mailboxConnection: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockImplementation(async () => current),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const notifications = {
    sendToUser: jest.fn().mockImplementation(async () => {
      tenantSeenBy.push(`in-app:${tenantCtx.getOrNull()}`);
      return 1;
    }),
  };
  const email = {
    isEmailConfigured: jest.fn().mockImplementation(async () => {
      tenantSeenBy.push(`fallback-check:${tenantCtx.getOrNull()}`);
      return opts.hasFallback ?? true;
    }),
    sendMailboxRevokedNotice: jest
      .fn()
      .mockResolvedValue({ delivered: true, transport: "smtp", id: "plat-1" }),
    send: jest.fn(),
    sendPlatform: jest.fn(),
  };
  const mailboxSend = { onStateChange: jest.fn().mockReturnValue(jest.fn()) };
  const service = new MailboxAlertService(
    mailboxSend as any,
    prisma as any,
    tenantCtx,
    notifications as any,
    email as any,
  );
  const notify = service.notifyAdmins.bind(service);
  service.notifyAdmins = (c: MailboxStateChange) => {
    current = rowFor(c);
    return notify(c);
  };
  return { service, prisma, notifications, email, mailboxSend, tenantCtx, tenantSeenBy };
}

beforeEach(() => jest.clearAllMocks());

describe("MailboxAlertService — REVOKED", () => {
  it("in-app notification to EVERY active tenant admin of that tenant, plus one platform email each", async () => {
    const { service, prisma, notifications, email } = build();

    await service.notifyAdmins(change());

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-a", role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      }),
    );
    expect(notifications.sendToUser.mock.calls.map((c: any[]) => c[0])).toEqual([
      "u-owner",
      "u-partner",
    ]);
    expect(email.sendMailboxRevokedNotice.mock.calls.map((c: any[]) => c[0])).toEqual([
      {
        to: "owner@acme.test",
        username: "owner",
        accountEmail: "sales@acme.test",
        provider: "GOOGLE",
        hasFallback: true,
      },
      {
        to: "partner@acme.test",
        username: "partner",
        accountEmail: "sales@acme.test",
        provider: "GOOGLE",
        hasFallback: true,
      },
    ]);
    // The email goes ONLY through the platform-class notice — never a tenant-class send().
    expect(email.send).not.toHaveBeenCalled();
    expect(email.sendPlatform).not.toHaveBeenCalled();
  });

  it("the in-app copy says what happened, that email is still going out, and how to fix it", async () => {
    const { service, notifications } = build();

    await service.notifyAdmins(change());

    const payload = notifications.sendToUser.mock.calls[0][1];
    expect(payload.title).toBe("Reconnect your email");
    expect(payload.body).toContain(
      "RouteFlow can no longer send from sales@acme.test: access was removed.",
    );
    expect(payload.body).toContain(
      "Your emails are still going out, from your SMTP setup or RouteFlow's address.",
    );
    expect(payload.body).toContain("Settings → Email → Reconnect");
    expect(payload.data).toEqual({ event: "mailbox.revoked_detected" });
  });

  it("never promises a fallback that doesn't exist", async () => {
    const { service, notifications, email } = build({ hasFallback: false });

    await service.notifyAdmins(change());

    const { body } = notifications.sendToUser.mock.calls[0][1];
    expect(body).toContain("Your emails can't be sent until you reconnect.");
    expect(body).not.toContain("still going out");
    expect(email.sendMailboxRevokedNotice.mock.calls[0][0].hasFallback).toBe(false);
  });

  it("emails each mailbox once: skips the no-email sentinel, and dedupes addresses that differ only in case", async () => {
    const { service, notifications, email } = build({
      admins: [
        { id: "u-1", email: "owner@acme.test", username: "owner" },
        { id: "u-2", email: "OWNER@acme.test", username: "owner-dup" },
        { id: "u-3", email: "no-email+1f2e@placeholder.local", username: "no-mail" },
      ],
    });

    await service.notifyAdmins(change());

    expect(notifications.sendToUser).toHaveBeenCalledTimes(3); // in-app is per ADMIN
    expect(email.sendMailboxRevokedNotice.mock.calls.map((c: any[]) => c[0].to)).toEqual([
      "owner@acme.test",
    ]);
  });
});

describe("MailboxAlertService — THROTTLED", () => {
  it("in-app only: every admin is told, and no email of any kind is sent", async () => {
    const { service, notifications, email } = build();

    await service.notifyAdmins(
      change({
        status: "THROTTLED",
        reasonCode: "rate_limited",
        provider: "MICROSOFT",
        throttledUntil: new Date(Date.now() + 60 * 60_000),
      }),
    );

    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    expect(email.sendMailboxRevokedNotice).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(email.sendPlatform).not.toHaveBeenCalled();
    const payload = notifications.sendToUser.mock.calls[0][1];
    expect(payload.title).toBe("Microsoft is limiting your emails");
    expect(payload.body).toContain(
      "Microsoft is limiting how many emails RouteFlow can send from sales@acme.test.",
    );
    expect(payload.body).toContain("For about an hour, your emails go out from your SMTP setup");
    expect(payload.body).toContain("there's nothing to do");
    expect(payload.data).toEqual({ event: "mailbox.throttled_detected" });
  });
});

describe("MailboxAlertService — robustness", () => {
  it("runs inside the change's OWN tenant context, whatever context the detecting send ran in", async () => {
    const { service, tenantCtx, tenantSeenBy } = build();

    await tenantCtx.run("some-other-tenant", () => service.notifyAdmins(change()));

    expect(tenantSeenBy.length).toBeGreaterThan(0);
    expect(new Set(tenantSeenBy.map((s) => s.split(":")[1]))).toEqual(new Set(["tenant-a"]));
  });

  it("with no active admin nothing is sent, and it resolves", async () => {
    const { service, notifications, email } = build({ admins: [] });

    await expect(service.notifyAdmins(change())).resolves.toBeUndefined();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    expect(email.sendMailboxRevokedNotice).not.toHaveBeenCalled();
  });

  it("one admin's failed in-app notification does not stop the others, nor the email", async () => {
    const { service, notifications, email } = build();
    notifications.sendToUser.mockRejectedValueOnce(new Error("expo down"));

    await expect(service.notifyAdmins(change())).resolves.toBeUndefined();
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(2);
  });

  it("never throws: an admin-lookup failure or an email failure is swallowed", async () => {
    const lookupFails = build();
    lookupFails.prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(lookupFails.service.notifyAdmins(change())).resolves.toBeUndefined();

    const emailFails = build();
    emailFails.email.sendMailboxRevokedNotice.mockRejectedValue(new Error("smtp down"));
    await expect(emailFails.service.notifyAdmins(change())).resolves.toBeUndefined();
    expect(emailFails.email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(2);
  });
});

describe("MailboxAlertService — subscription wiring", () => {
  it("onModuleInit subscribes to MailboxSendService state changes; onModuleDestroy unsubscribes", async () => {
    const { service, mailboxSend } = build();
    const unsubscribe = jest.fn();
    mailboxSend.onStateChange.mockReturnValue(unsubscribe);

    service.onModuleInit();
    expect(mailboxSend.onStateChange).toHaveBeenCalledTimes(1);
    const notify = jest.spyOn(service, "notifyAdmins").mockResolvedValue(undefined);
    const listener = mailboxSend.onStateChange.mock.calls[0][0];
    await listener(change());
    expect(notify).toHaveBeenCalledWith(change());

    service.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("end to end: a real MailboxSendService revocation reaches the admins exactly once", async () => {
    const encryption = new EncryptionService({
      get: (k: string) => (k === "ENCRYPTION_KEY" ? "f".repeat(64) : undefined),
    } as unknown as ConfigService);
    const conn = {
      id: "mc-1",
      tenantId: "tenant-a",
      provider: "MICROSOFT",
      accountEmail: "sales@acme.test",
      externalSubject: "oid-1",
      status: "CONNECTED",
      throttledUntil: null,
      refreshTokenCipher: encryption.encrypt("rt"),
      accessTokenCipher: encryption.encrypt("at"),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    };
    const prisma: any = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(conn),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const mailboxSend = new MailboxSendService(
      prisma,
      encryption,
      {
        get: () => undefined,
      } as unknown as ConfigService,
      {
        decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
      } as any,
    );
    const {
      notifications,
      email,
      prisma: alertPrisma,
      tenantCtx,
    } = build({
      admins: [ADMINS[0]],
    });
    alertPrisma.mailboxConnection.findUnique.mockResolvedValue(
      rowFor(change({ provider: "MICROSOFT" })),
    );
    const alerts = new MailboxAlertService(
      mailboxSend,
      alertPrisma as any,
      tenantCtx,
      notifications as any,
      email as any,
    );
    alerts.onModuleInit();
    // Delivery is detached from the send — wait for the email itself, not for wall-clock time.
    const emailed = new Promise<void>((resolve) =>
      email.sendMailboxRevokedNotice.mockImplementation(async () => {
        resolve();
        return { delivered: true, transport: "smtp" };
      }),
    );
    const err: any = new Error("Request failed with status code 401");
    err.response = { status: 401, data: { error: { code: "InvalidAuthenticationToken" } } };
    (axios.post as jest.Mock).mockRejectedValue(err);

    const res = await mailboxSend.trySend("tenant-a", {
      to: "customer@example.test",
      subject: "Invoice",
      html: "<p>hi</p>",
    });
    await emailed;

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser.mock.calls[0][0]).toBe("u-owner");
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(1);
    expect(email.sendMailboxRevokedNotice.mock.calls[0][0]).toMatchObject({
      to: "owner@acme.test",
      accountEmail: "sales@acme.test",
      provider: "MICROSOFT",
    });
    alerts.onModuleDestroy();
  });
});

describe("MailboxAlertService — durable settlement (#2113, SA-528)", () => {
  it("pins the lease at ≥ 3× the sweep cadence, and the delivery deadline well inside it", () => {
    expect(MAILBOX_ALERT_LEASE_MS).toBeGreaterThanOrEqual(
      3 * MAILBOX_ALERT_SWEEP_EVERY_MIN * 60_000,
    );
    expect(MAILBOX_ALERT_DELIVERY_DEADLINE_MS).toBeLessThanOrEqual(2 * 60_000);
    expect(MAILBOX_ALERT_DELIVERY_DEADLINE_MS).toBeLessThan(MAILBOX_ALERT_LEASE_MS);
  });

  it("the sweep's cron expression matches the pinned cadence", () => {
    const src = fs.readFileSync(path.join(__dirname, "mailbox-alert.service.ts"), "utf8");
    expect(src).toContain(
      `@LeaderCron("*/${MAILBOX_ALERT_SWEEP_EVERY_MIN} * * * *", "mailbox-alert.sweepPending")`,
    );
  });

  it.each([null, undefined, new Date("not a date")])(
    "a seen value of %p issues NO compare-and-set and delivers nothing",
    async (seen) => {
      const { service, prisma, notifications } = build();
      await expect(service.settle("mc-1", seen as any)).resolves.toBe("not-claimed");
      expect(prisma.mailboxConnection.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    },
  );

  it("claims by CAS on the seen value, delivers, then clears by CAS on the lease", async () => {
    const { service, prisma, notifications } = build();
    service.now = () => new Date("2026-09-28T00:01:00.000Z");

    await service.notifyAdmins(change());

    const [claim, clear] = prisma.mailboxConnection.updateMany.mock.calls.map((c: any[]) => c[0]);
    const lease = new Date(Date.parse("2026-09-28T00:01:00.000Z") + MAILBOX_ALERT_LEASE_MS);
    expect(claim).toEqual({
      where: { id: "mc-1", alertPendingAt: PENDING_AT },
      data: { alertPendingAt: lease },
    });
    expect(clear).toEqual({
      where: { id: "mc-1", alertPendingAt: lease },
      data: { alertPendingAt: null },
    });
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
  });

  it("a lost claim (count 0) delivers nothing and clears nothing", async () => {
    const { service, prisma, notifications, email } = build();
    prisma.mailboxConnection.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.settle("mc-1", PENDING_AT)).resolves.toBe("not-claimed");
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    expect(email.sendMailboxRevokedNotice).not.toHaveBeenCalled();
  });

  it.each([
    ["reconnected", { status: "CONNECTED", throttledUntil: null }],
    ["a throttle that has already lifted", { status: "THROTTLED", throttledUntil: new Date(0) }],
  ])("a row that is %s at claim time is cleared WITHOUT notifying", async (_label, state) => {
    const { service, prisma, notifications } = build();
    prisma.mailboxConnection.findUnique.mockResolvedValue({ ...rowFor(change()), ...state });

    await expect(service.settle("mc-1", PENDING_AT)).resolves.toBe("stale");
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(2); // claim + clear
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("no active admin: cleared (nothing to deliver), never left owed", async () => {
    const { service, prisma } = build({ admins: [] });
    await expect(service.settle("mc-1", PENDING_AT)).resolves.toBe("delivered");
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(2);
  });

  it("a failed delivery (admin lookup down) is abandoned WITHOUT clearing — the sweep retries", async () => {
    const { service, prisma } = build();
    prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(service.settle("mc-1", PENDING_AT)).resolves.toBe("abandoned");
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(1); // the claim only
  });

  it("a delivery that overruns the deadline is abandoned WITHOUT clearing", async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, email } = build();
      email.isEmailConfigured.mockImplementation(() => new Promise(() => {})); // hangs forever
      const settled = service.settle("mc-1", PENDING_AT);
      await jest.advanceTimersByTimeAsync(MAILBOX_ALERT_DELIVERY_DEADLINE_MS + 1);
      await expect(settled).resolves.toBe("abandoned");
      expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("sweepPending settles every due row and counts the deliveries", async () => {
    const { service, prisma, notifications } = build();
    prisma.mailboxConnection.findMany.mockResolvedValue([
      { id: "mc-1", alertPendingAt: PENDING_AT },
      { id: "mc-2", alertPendingAt: PENDING_AT },
    ]);
    prisma.mailboxConnection.updateMany
      .mockResolvedValueOnce({ count: 1 }) // mc-1 claim
      .mockResolvedValueOnce({ count: 1 }) // mc-1 clear
      .mockResolvedValueOnce({ count: 0 }); // mc-2 claim lost to another deliverer

    await expect(service.sweepPending()).resolves.toBe(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2); // mc-1's two admins only
  });
});
