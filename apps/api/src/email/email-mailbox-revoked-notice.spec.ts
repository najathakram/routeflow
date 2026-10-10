/**
 * F-10a (#2077) — the email a tenant admin gets when their connected mailbox is revoked. It is
 * RouteFlow telling its own customer that THEIR mailbox can't send, so it must go out through the
 * PLATFORM sender class: never through the connected (dead) mailbox, never through the tenant's
 * own SMTP, never under the tenant's branding — even though it is sent while that tenant's
 * context is active, with a mailbox, tenant SMTP and a verified own sending domain all present.
 */
jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";
import { EmailService } from "./email.service";

const PLATFORM_FROM = "RouteFlow <invoices@send.routeflow.info>";

function makeService() {
  const env: Record<string, string | undefined> = {
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: PLATFORM_FROM,
    WEB_URL: "https://app.routeflow.test/",
  };
  const config = { get: (k: string) => env[k] } as any;
  // Everything a TENANT-class send would use instead: the tenant's own SMTP (Settings → Email),
  // its verified own sending domain, and its business name + customer-facing reply address.
  const prisma = {
    getTenantId: () => "tenant-a",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([
          { key: "email.smtpHost", value: "smtp.acme.test" },
          { key: "email.smtpUser", value: "billing@acme.test" },
          { key: "email.smtpPassword", value: "tenant-smtp-password" },
          { key: "email.fromEmail", value: "billing@acme.test" },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          value: JSON.stringify({
            domain: "acme.test",
            status: "verified",
            fromAddress: "billing@acme.test",
          }),
        }),
      },
    }),
    tenantConfig: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ businessName: "Acme Wholesale", customerEmail: "hello@acme.test" }),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const mailboxSend = { trySend: jest.fn() };
  const svc = new EmailService(
    config,
    prisma,
    { decrypt: (v: string) => v } as any,
    mailboxSend as any,
    { record: jest.fn() } as any,
  );
  const resendSend = jest.fn().mockResolvedValue({ data: { id: "eml_1" }, error: null });
  (svc as any).resend.emails.send = resendSend;
  return { svc, mailboxSend, resendSend };
}

const NOTICE = {
  to: "owner@acme.test",
  username: "Owner",
  accountEmail: "sales@acme.test",
  provider: "GOOGLE" as const,
  hasFallback: true,
};

beforeEach(() => jest.clearAllMocks());

describe("EmailService.sendMailboxRevokedNotice (F-10a)", () => {
  it("is sent with senderClass 'platform'", async () => {
    const { svc } = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);

    await svc.sendMailboxRevokedNotice(NOTICE);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@acme.test",
        subject: "RouteFlow can no longer send from sales@acme.test",
        senderClass: "platform",
      }),
    );
  });

  it("never reaches the connected mailbox or the tenant's SMTP, and leaves under RouteFlow's own From", async () => {
    const { svc, mailboxSend, resendSend } = makeService();

    const res = await svc.sendMailboxRevokedNotice(NOTICE);

    expect(res).toMatchObject({ delivered: true, transport: "resend" });
    expect(mailboxSend.trySend).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(resendSend).toHaveBeenCalledTimes(1);
    const sent = resendSend.mock.calls[0][0];
    expect(sent.from).toBe(PLATFORM_FROM); // not "Acme Wholesale <billing@acme.test>"
    expect(sent.replyTo).toBeUndefined(); // not the tenant's own reply address
    expect(sent.to).toBe("owner@acme.test");
  });

  it("says what happened, where email goes meanwhile, and how to fix it — in the HTML and the plain text", async () => {
    const { svc, resendSend } = makeService();

    await svc.sendMailboxRevokedNotice(NOTICE);

    const { html, text } = resendSend.mock.calls[0][0];
    expect(text).toContain("Hi Owner,");
    expect(text).toContain(
      "RouteFlow can no longer send from sales@acme.test: access was removed.",
    );
    expect(text).toContain("RouteFlow's access in the Google account");
    expect(text).toContain(
      "Your emails are still going out, just not from sales@acme.test. Until you reconnect, they are sent from your SMTP setup, or from RouteFlow's address if you don't have one.",
    );
    expect(text).toContain("go to Settings → Email and click Reconnect.");
    expect(text).toContain("Open email settings: https://app.routeflow.test/settings?tab=email");
    expect(html).toContain("Reconnect your email");
    expect(html).toContain(
      "RouteFlow can no longer send from sales@acme.test: access was removed.",
    );
    expect(html).toContain("go to Settings → Email and click Reconnect.");
    expect(html).toContain('href="https://app.routeflow.test/settings?tab=email"');
  });

  it("without a fallback sender, it says email is stopped instead of promising one", async () => {
    const { svc, resendSend } = makeService();

    await svc.sendMailboxRevokedNotice({ ...NOTICE, provider: "MICROSOFT", hasFallback: false });

    const { text } = resendSend.mock.calls[0][0];
    expect(text).toContain(
      "Until you reconnect, RouteFlow can't send your emails: there is no other sender set up.",
    );
    expect(text).not.toContain("still going out");
    expect(text).toContain("RouteFlow's access in the Microsoft account");
  });
});
