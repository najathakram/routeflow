/**
 * F-10a (#2077) — who hears about an automatic mailbox state change, through which channel, and
 * what they are told. REVOKED: an in-app notification to every active tenant admin AND an email
 * through the PLATFORM sender (never the dead mailbox). THROTTLED: in-app only. The copy says what
 * happened, where the tenant's email goes meanwhile, and how to fix it. Never throws.
 */
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { EncryptionService } from "../../common/encryption.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { MailboxAlertService } from "./mailbox-alert.service";
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
    ...over,
  };
}

const ADMINS = [
  { id: "u-owner", email: "owner@acme.test", username: "owner" },
  { id: "u-partner", email: "partner@acme.test", username: "partner" },
];

function build(opts: { admins?: typeof ADMINS; hasFallback?: boolean } = {}) {
  const tenantCtx = new TenantContextService();
  const tenantSeenBy: string[] = [];
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue(opts.admins ?? ADMINS) },
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
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(conn),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mailboxSend = new MailboxSendService(
      prisma as any,
      encryption,
      { get: () => undefined } as unknown as ConfigService,
      audit as any,
    );
    const {
      notifications,
      email,
      prisma: alertPrisma,
      tenantCtx,
    } = build({
      admins: [ADMINS[0]],
    });
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
    expect(audit.log).toHaveBeenCalledTimes(1);
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
