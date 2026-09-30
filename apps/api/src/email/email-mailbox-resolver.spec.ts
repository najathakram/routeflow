import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";

/**
 * email-connect-google PR-3 — `send()`'s new leading branch (no parallel path): a connected
 * tenant Google mailbox sends FIRST, never for a platform-class send, and any non-delivery
 * (not connected, REVOKED, THROTTLED, refresh failure, Gmail error) falls through to the
 * EXISTING tenant-SMTP → platform-SMTP → Resend chain, unchanged.
 */
function makeService(opts: {
  mailboxResult: {
    delivered: boolean;
    transport: "mailbox";
    id?: string;
    fromAddress?: string;
    error?: string;
  };
  systemConfigRows?: any[];
  smtpHost?: string;
  smtpUser?: string;
  smtpPass?: string;
  senderClass?: "tenant" | "platform";
  tenantId?: string | null;
}): { svc: EmailService; mailboxSend: { trySend: jest.Mock }; nodemailerSendMail: jest.Mock } {
  const envMap: Record<string, string | undefined> = {
    SMTP_HOST: opts.smtpHost,
    SMTP_USER: opts.smtpUser,
    SMTP_PASS: opts.smtpPass,
  };
  const config = { get: (k: string) => envMap[k] } as any;
  const prisma = {
    getTenantId: () => (opts.tenantId === undefined ? "tenant-a" : opts.tenantId),
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(opts.systemConfigRows ?? []),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: {
      findFirst: jest.fn().mockResolvedValue({ businessName: "Acme Wholesale" }),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const encryption = { decrypt: (v: string) => v } as any;
  const mailboxSend = { trySend: jest.fn().mockResolvedValue(opts.mailboxResult) };
  const svc = new EmailService(config, prisma, encryption, mailboxSend as any);

  const nodemailerSendMail = jest.fn().mockResolvedValue({ messageId: "smtp-msg-1" });
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: nodemailerSendMail });

  return { svc, mailboxSend, nodemailerSendMail };
}

describe("EmailService.send — connected-mailbox leading branch (PR-3)", () => {
  it("CONNECTED mailbox delivers: transport='mailbox', tenant SMTP (nodemailer) is never touched", async () => {
    const { svc, mailboxSend, nodemailerSendMail } = makeService({
      mailboxResult: {
        delivered: true,
        transport: "mailbox",
        id: "gmail-1",
        fromAddress: "owner@acme.test",
      },
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "u" },
        { key: "email.smtpPassword", value: "p" },
      ],
    });

    const res = await svc.send({ to: "customer@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "mailbox", id: "gmail-1" });
    expect(mailboxSend.trySend).toHaveBeenCalledTimes(1);
    expect(nodemailerSendMail).not.toHaveBeenCalled();
  });

  it("mailbox THROTTLED (delivered:false): falls through and tenant SMTP is called exactly once in the SAME send", async () => {
    const { svc, mailboxSend, nodemailerSendMail } = makeService({
      mailboxResult: { delivered: false, transport: "mailbox", error: "throttled" },
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "u@example.com" },
        { key: "email.smtpPassword", value: "p" },
        { key: "email.smtpPort", value: "587" },
        { key: "email.smtpSecure", value: "false" },
      ],
    });

    const res = await svc.send({ to: "customer@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(mailboxSend.trySend).toHaveBeenCalledTimes(1);
    expect(nodemailerSendMail).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ delivered: true, transport: "smtp", id: "smtp-msg-1" });
  });

  it("mailbox REVOKED (delivered:false): falls through and tenant SMTP is called exactly once", async () => {
    const { svc, mailboxSend, nodemailerSendMail } = makeService({
      mailboxResult: { delivered: false, transport: "mailbox", error: "revoked" },
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "u@example.com" },
        { key: "email.smtpPassword", value: "p" },
      ],
    });

    const res = await svc.send({ to: "customer@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(mailboxSend.trySend).toHaveBeenCalledTimes(1);
    expect(nodemailerSendMail).toHaveBeenCalledTimes(1);
    expect(res.transport).toBe("smtp");
  });

  it("senderClass:'platform' skips the mailbox branch entirely — trySend is never called, and tenant SMTP is skipped too", async () => {
    const { svc, mailboxSend, nodemailerSendMail } = makeService({
      mailboxResult: { delivered: true, transport: "mailbox", id: "should-never-be-used" },
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "u@example.com" },
        { key: "email.smtpPassword", value: "p" },
      ],
    });

    const res = await svc.send({
      to: "user@example.com",
      subject: "Verify your email",
      html: "<p>verify</p>",
      senderClass: "platform",
    });

    expect(mailboxSend.trySend).not.toHaveBeenCalled();
    expect(nodemailerSendMail).not.toHaveBeenCalled();
    // No platform SMTP/Resend configured in this fixture either → honest no-transport result,
    // never a silent success and never an attempt against the tenant's own mailbox/SMTP.
    expect(res).toMatchObject({ delivered: false, transport: "none" });
  });

  it("no tenant context (getTenantId() → null, e.g. a cron/platform-only call path): the mailbox branch is skipped", async () => {
    const { svc, mailboxSend } = makeService({
      mailboxResult: { delivered: true, transport: "mailbox", id: "should-never-be-used" },
      tenantId: null,
    });

    await svc.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" });

    expect(mailboxSend.trySend).not.toHaveBeenCalled();
  });
});
