import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";

/**
 * R5 — the email layer must be HONEST: `send()` returns `{delivered:false}` (never a
 * silent mock "success") when nothing is configured or a send fails, and it reads the
 * SMTP config from the same SystemConfig `email.*` store the Settings → Email tab
 * writes (the wiring fix). These tests exercise the no-network paths (unconfigured /
 * config-read); real SMTP/Resend delivery is covered by the invoice send-honesty specs.
 */
function makeService(
  opts: {
    resendKey?: string;
    emailFrom?: string;
    systemConfigRows?: any[];
    sendingDomainRow?: any;
    tenantConfig?: any;
  } = {},
): EmailService {
  const config = {
    get: (k: string) =>
      k === "RESEND_API_KEY" ? opts.resendKey : k === "EMAIL_FROM" ? opts.emailFrom : undefined,
  } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(opts.systemConfigRows ?? []),
        // email.sendingDomain (verified own-domain from-address), Phase 2.
        findFirst: jest.fn().mockResolvedValue(opts.sendingDomainRow ?? null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(opts.tenantConfig ?? null) },
  } as any;
  const encryption = { decrypt: (v: string) => v } as any;
  return new EmailService(config, prisma, encryption);
}

describe("EmailService — honest send (R5)", () => {
  it("send() returns {delivered:false, transport:'none'} when nothing is configured", async () => {
    const svc = makeService();
    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });
    expect(res).toMatchObject({ delivered: false, transport: "none" });
  });

  it("isEmailConfigured() is false with no Resend key and no SMTP config", async () => {
    expect(await makeService().isEmailConfigured()).toBe(false);
  });

  it("isEmailConfigured() is true when the platform Resend key is set", async () => {
    expect(await makeService({ resendKey: "re_test_key" }).isEmailConfigured()).toBe(true);
  });

  it("reads SMTP from the SystemConfig email.* store (Settings → Email wiring fix)", async () => {
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "plaintext-legacy-pw" }, // not enc format → passthrough
        { key: "email.smtpPort", value: "587" },
      ],
    });
    expect(await svc.isEmailConfigured()).toBe(true);
  });

  it("tenant-SMTP send transport is created with fail-fast timeouts (invoice-send hang fix)", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
    });
    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });
    expect(res).toMatchObject({ delivered: true, transport: "smtp" });
    // Without these, nodemailer waits 2 minutes on an unreachable SMTP host and
    // every invoice send/email request hangs before the Resend fallback.
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        dnsTimeout: 10_000,
      }),
    );
  });

  it("ignores a PARTIAL SystemConfig email.* config (no password) and reports unconfigured", async () => {
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        // no smtpPassword → not usable
      ],
    });
    expect(await svc.isEmailConfigured()).toBe(false);
  });
});

/**
 * WP4 — fail-securely on STARTTLS-less 587: a 587 server that won't offer STARTTLS is
 * accepting the tenant's password in cleartext, so `requireTLS: port===587 && !secure`
 * is set on both transports (mirrors the pre-save verify transport tested separately in
 * `email-smtp-verify.spec.ts`).
 */
describe("EmailService — requireTLS (fail-secure on 587 without SSL)", () => {
  const smtpRows = (port: string, secure: string) => [
    { key: "email.smtpHost", value: "smtp.example.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: port },
    { key: "email.smtpSecure", value: secure },
  ];

  it("sets requireTLS on the SEND transport for 587 with secure off", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows("587", "false") });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it("does NOT set requireTLS on the SEND transport for 465 with secure on", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows("465", "true") });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });
});

/**
 * WP4 — `smtpFallbackReason`: mapSmtpError(...) is captured at the SMTP catch and must
 * ride along on EVERY branch that follows it (Resend rescue, both-fail, no-Resend) — the
 * Resend-rescue case is exactly the one where, before this, nobody learned their own
 * tenant SMTP was broken because `delivered:true` looked like nothing was wrong.
 */
describe("EmailService — smtpFallbackReason (mapped SMTP diagnostic on every branch)", () => {
  const smtpRows = () => [
    { key: "email.smtpHost", value: "smtp.office365.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: "587" },
    { key: "email.smtpSecure", value: "false" },
  ];
  // The M365 disabled-Authenticated-SMTP fixture (5.7.139) — the exact failure the
  // BYO-SMTP-first direction is meant to catch and explain.
  const m365AuthError = () =>
    Object.assign(
      new Error(
        "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
      ),
      { code: "EAUTH", responseCode: 535 },
    );

  it("SMTP fails + Resend rescues ⇒ delivered:true WITH the mapped smtpFallbackReason", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: { id: "eml_1" }, error: null });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "resend" });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
    // The From identity silently changed too (tenant mailbox → platform address) —
    // that must ride along so the operator-facing toast can disclose it, not bury it.
    expect(res.fromAddress).toBe("invoices@send.routeflow.info");
  });

  it("both SMTP and Resend fail ⇒ delivered:false, but the mapped smtpFallbackReason is still present", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "domain not verified" } });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({
      delivered: false,
      transport: "resend",
      error: "domain not verified",
    });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
  });

  it("SMTP fails with no Resend configured ⇒ delivered:false, transport:'smtp', mapped smtpFallbackReason", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows() }); // no resendKey → no rescue

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: false, transport: "smtp" });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
  });
});

/**
 * WP4 — `sendTestEmail` must never fall back to the generic message when a mapped
 * reason exists: a mapped failure is more actionable, and a Resend-rescued delivery
 * must say BOTH "it arrived" and "your own SMTP is broken", not just the former.
 */
describe("EmailService.sendTestEmail — mapped reason over generic text", () => {
  const smtpRows = () => [
    { key: "email.smtpHost", value: "smtp.office365.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: "587" },
    { key: "email.smtpSecure", value: "false" },
  ];
  const m365AuthError = () =>
    Object.assign(
      new Error(
        "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
      ),
      { code: "EAUTH", responseCode: 535 },
    );

  it("SMTP fails + no Resend ⇒ success:false with the MAPPED message, not the generic one", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows() });

    const res = await svc.sendTestEmail("a@b.com");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Authenticated SMTP/);
    expect(res.message).not.toMatch(/Failed to send test email/);
  });

  it("SMTP fails + Resend delivers ⇒ success:true with the mapped SMTP reason APPENDED", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: { id: "eml_1" }, error: null });

    const res = await svc.sendTestEmail("a@b.com");

    // Honest about delivery AND about the underlying tenant-SMTP problem.
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/delivered/i);
    expect(res.message).toMatch(/Authenticated SMTP/);
  });

  it("nothing configured at all ⇒ keeps the generic 'not set up' guidance", async () => {
    const svc = makeService(); // no resend key, no SMTP config
    const res = await svc.sendTestEmail("a@b.com");
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/isn't set up yet/i);
  });
});

describe("EmailService — transactional From identity + reply-to (Phase 1)", () => {
  it("Resend sends from '<Business name> <platform address>' with the tenant Reply-To", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co", customerEmail: "hello@acme.com" },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_1" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    const res = await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "resend" });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Acme Co <invoices@send.routeflow.info>",
        replyTo: "hello@acme.com",
        to: "buyer@x.com",
      }),
    );
  });

  it("uses a VERIFIED own-domain from-address when the tenant has set one up", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co", customerEmail: "hello@acme.com" },
      sendingDomainRow: {
        value: JSON.stringify({ status: "verified", fromAddress: "invoices@acme.com" }),
      },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_2" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co <invoices@acme.com>" }),
    );
  });

  it("does NOT use an own-domain address that isn't verified yet", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co" },
      sendingDomainRow: {
        value: JSON.stringify({ status: "pending", fromAddress: "invoices@acme.com" }),
      },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_3" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    // Pending → falls back to the platform verified address.
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co <invoices@send.routeflow.info>" }),
    );
  });
});

describe("EmailService — sending-domain management (Phase 2)", () => {
  const verified = (fromAddress: string | null = null) => ({
    value: JSON.stringify({
      domain: "mail.acme.com",
      resendId: "d1",
      status: "verified",
      records: [],
      fromAddress,
    }),
  });

  it("addSendingDomain refuses when platform email (Resend) isn't configured", async () => {
    await expect(makeService().addSendingDomain("mail.acme.com")).rejects.toThrow(
      /platform email/i,
    );
  });

  it("addSendingDomain rejects an invalid domain", async () => {
    await expect(
      makeService({ resendKey: "re_test" }).addSendingDomain("not a domain"),
    ).rejects.toThrow(/valid domain/i);
  });

  it("getSendingDomainStatus reflects the stored verified config", async () => {
    const svc = makeService({
      resendKey: "re_test",
      sendingDomainRow: verified("invoices@mail.acme.com"),
    });
    expect(await svc.getSendingDomainStatus()).toMatchObject({
      platformConfigured: true,
      domain: "mail.acme.com",
      status: "verified",
      fromAddress: "invoices@mail.acme.com",
    });
  });

  it("setSendingFromAddress rejects an address not on the verified domain", async () => {
    const svc = makeService({ resendKey: "re_test", sendingDomainRow: verified() });
    await expect(svc.setSendingFromAddress("invoices@wrong.com")).rejects.toThrow(
      /must be on mail\.acme\.com/i,
    );
  });

  it("setSendingFromAddress requires the domain to be verified first", async () => {
    const svc = makeService({
      resendKey: "re_test",
      sendingDomainRow: {
        value: JSON.stringify({ domain: "mail.acme.com", resendId: "d1", status: "pending" }),
      },
    });
    await expect(svc.setSendingFromAddress("invoices@mail.acme.com")).rejects.toThrow(/verify/i);
  });
});
