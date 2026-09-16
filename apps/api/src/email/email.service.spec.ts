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
    smtpHost?: string;
    smtpPort?: string;
    smtpSecure?: string;
    smtpUser?: string;
    smtpPass?: string;
    adminUser?: any;
  } = {},
): EmailService {
  const envMap: Record<string, string | undefined> = {
    RESEND_API_KEY: opts.resendKey,
    EMAIL_FROM: opts.emailFrom,
    SMTP_HOST: opts.smtpHost,
    SMTP_PORT: opts.smtpPort,
    SMTP_SECURE: opts.smtpSecure,
    SMTP_USER: opts.smtpUser,
    SMTP_PASS: opts.smtpPass,
  };
  const config = { get: (k: string) => envMap[k] } as any;
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
    user: { findFirst: jest.fn().mockResolvedValue(opts.adminUser ?? null) },
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

  // B452 (c) — fail-closed is a promise this codebase makes to every fire-and-forget
  // caller (password reset, account-merge): a misconfigured/absent provider must
  // resolve to a structured result, never reject the promise into the caller.
  it("send() never throws when no provider is configured — resolves to a not-sent result", async () => {
    const svc = makeService();
    await expect(
      svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" }),
    ).resolves.toMatchObject({ delivered: false, transport: "none", error: undefined });
  });

  it("sendTestEmail() never throws when no provider is configured", async () => {
    const svc = makeService();
    await expect(svc.sendTestEmail("a@b.com")).resolves.toMatchObject({ success: false });
  });
});

/**
 * B452 (a) — the tenant-branded sender fallback must never hard-code a domain
 * RouteFlow doesn't own. Previously `getTenantFromAddress()` fell back to a literal
 * "noreply@routeflow.app" (the real domain is routeflow.info) whenever a tenant had
 * a businessName but no From-email configured under Settings → Email. It must now
 * ride the platform's own verified EMAIL_FROM address instead.
 */
describe("EmailService — sender resolver never hard-codes a domain (B452)", () => {
  it("tenant SMTP send with no fromEmail configured uses the platform address, not routeflow.app", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
      // No smtpFromEmail on TenantConfig — only a businessName — is exactly the
      // fallback branch that used to hard-code routeflow.app.
      tenantConfig: { businessName: "Acme Co" },
    });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "smtp" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co via RouteFlow <noreply@routeflow.info>" }),
    );
    const sentFrom = sendMail.mock.calls[0][0].from as string;
    expect(sentFrom).not.toMatch(/routeflow\.app/);
  });

  it("falls back to the bare platform address when the tenant has no businessName either", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
      tenantConfig: null,
    });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "RouteFlow <noreply@routeflow.info>" }),
    );
  });
});

/**
 * B452 (d) — owner ruling 2026-09-16: the PLATFORM sender is Google Workspace SMTP,
 * not Resend. SMTP_HOST/PORT/SECURE/USER/PASS configure the platform transport;
 * it is selected over Resend whenever set, and the two are never both attempted for
 * the same send.
 */
describe("EmailService — platform SMTP transport (B452 owner ruling 2026-09-16)", () => {
  it("isEmailConfigured() is true when platform SMTP is set and no Resend key exists", async () => {
    const svc = makeService({
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
    });
    expect(await svc.isEmailConfigured()).toBe(true);
  });

  it("sends via platform SMTP (not Resend) when SMTP_HOST is set, even if RESEND_API_KEY is also set", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "plat-1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      smtpHost: "smtp.gmail.com",
      smtpPort: "587",
      smtpSecure: "false",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
      resendKey: "re_should_be_ignored",
    });
    // No Resend client should even exist — never both transports active.
    expect((svc as any).resend).toBeNull();

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "smtp", id: "plat-1" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        requireTLS: true,
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "RouteFlow <noreply@routeflow.info>", to: "a@b.com" }),
    );
  });

  it("platform SMTP failure is honest (delivered:false) and never throws, with no Resend to rescue it", async () => {
    const gmailAuthError = Object.assign(new Error("Invalid login: 535-5.7.8"), {
      code: "EAUTH",
      responseCode: 535,
    });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: jest.fn().mockRejectedValue(gmailAuthError),
    });
    const svc = makeService({
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "wrong-pw",
    });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res.delivered).toBe(false);
    expect(res.transport).toBe("smtp");
    expect(res.smtpFallbackReason).toMatch(/App Password|password/i);
  });

  it("falls back to Resend when SMTP_HOST is not set but RESEND_API_KEY is", async () => {
    const svc = makeService({ resendKey: "re_test" });
    expect((svc as any).platformSmtp).toBeNull();
    expect((svc as any).resend).not.toBeNull();
  });
});

/**
 * Opus review of B452 (2026-09-16) — MAJOR findings, fixed here with failing-first tests.
 */
describe("EmailService — B452 review fixes: partial SMTP config never disables Resend", () => {
  it("ignores a partial platform SMTP config (host set, user/pass missing) and falls through to Resend", async () => {
    const svc = makeService({ smtpHost: "smtp.gmail.com", resendKey: "re_test" });
    expect((svc as any).platformSmtp).toBeNull();
    expect((svc as any).resend).not.toBeNull();
    expect(await svc.isEmailConfigured()).toBe(true);
  });

  it("ignores a partial platform SMTP config (user set, pass missing) even with no Resend key", async () => {
    const svc = makeService({ smtpHost: "smtp.gmail.com", smtpUser: "noreply@routeflow.info" });
    expect((svc as any).platformSmtp).toBeNull();
    expect(await svc.isEmailConfigured()).toBe(false);
  });

  it("only selects platform SMTP when host, user, AND pass are all present", async () => {
    const svc = makeService({
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
      resendKey: "re_should_be_ignored",
    });
    expect((svc as any).platformSmtp).not.toBeNull();
    expect((svc as any).resend).toBeNull();
  });
});

describe("EmailService — B452 review fixes: EMAIL_FROM derivation + tenant branding on platform SMTP", () => {
  it("derives the sender from SMTP_USER when EMAIL_FROM is unset but platform SMTP is fully configured", async () => {
    const svc = makeService({
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
    });
    expect((svc as any).platformFrom).toBe("RouteFlow <noreply@routeflow.info>");
  });

  it("keeps the built-in Resend-style default when platform SMTP is not configured at all", async () => {
    const svc = makeService({ resendKey: "re_test" });
    expect((svc as any).platformFrom).toBe("RouteFlow <invoices@send.routeflow.info>");
  });

  it("platform SMTP sends carry the tenant's brand, not just the bare platform address", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
      tenantConfig: { businessName: "Acme Co" },
    });

    await svc.send({ to: "buyer@x.com", subject: "x", html: "<p>x</p>" });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co via RouteFlow <noreply@routeflow.info>" }),
    );
  });

  it("platform SMTP falls back to the bare platform address with no tenant context", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
    });
    (svc as any).prisma.getTenantId = () => null;

    await svc.send({ to: "buyer@x.com", subject: "x", html: "<p>x</p>" });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "RouteFlow <noreply@routeflow.info>" }),
    );
  });
});

describe("EmailService — B452 review fixes: From-header injection via businessName", () => {
  // The sanitizer strips the STRUCTURAL `< > "` characters (matching the pre-existing
  // getResendFrom() convention) — that's what prevents header injection: a mail parser
  // can only ever find ONE addr-spec (the platform's own, at the end), no matter what
  // the tenant puts in businessName. It does not scrub email-shaped text from the
  // display name entirely — that's cosmetic, not a security property.
  it("sanitizes businessName on the platform-SMTP branded From — exactly one address survives", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      smtpHost: "smtp.gmail.com",
      smtpUser: "noreply@routeflow.info",
      smtpPass: "app-pw",
      tenantConfig: { businessName: "Acme <evil@attacker.com>" },
    });

    await svc.send({ to: "buyer@x.com", subject: "x", html: "<p>x</p>" });

    const from = (sendMail.mock.calls[0][0] as any).from as string;
    expect(from).toBe("Acme evil@attacker.com via RouteFlow <noreply@routeflow.info>");
    expect(from.match(/</g)).toHaveLength(1);
    expect(from.match(/>/g)).toHaveLength(1);
    // The one surviving address is the platform's own — not the injected one.
    expect(from.match(/<([^>]+)>/)?.[1]).toBe("noreply@routeflow.info");
  });

  it("sanitizes businessName on the tenant-SMTP fallback From too — exactly one address survives", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      emailFrom: "RouteFlow <noreply@routeflow.info>",
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
      tenantConfig: { businessName: "Acme <evil@attacker.com>" },
    });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    const from = (sendMail.mock.calls[0][0] as any).from as string;
    expect(from).toBe("Acme evil@attacker.com via RouteFlow <noreply@routeflow.info>");
    expect(from.match(/</g)).toHaveLength(1);
    expect(from.match(/>/g)).toHaveLength(1);
    expect(from.match(/<([^>]+)>/)?.[1]).toBe("noreply@routeflow.info");
  });
});

describe("EmailService — B452 review fixes: replyTo falls back to the tenant admin", () => {
  it("uses the tenant admin's email when no customerEmail/smtpFromEmail is configured", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
      tenantConfig: { businessName: "Acme Co" },
      adminUser: { email: "admin@acme.com" },
    });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "admin@acme.com" }));
  });

  it("stays undefined when no admin user exists either", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
      tenantConfig: { businessName: "Acme Co" },
    });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: undefined }));
  });
});

describe("EmailService — B452 review fixes: SMTP_SECURE/SMTP_PORT parsing", () => {
  it("accepts '1' and 'yes' as truthy for SMTP_SECURE, not only the literal 'true'", async () => {
    const svc1 = makeService({ smtpHost: "h", smtpUser: "u", smtpPass: "p", smtpSecure: "1" });
    const svc2 = makeService({ smtpHost: "h", smtpUser: "u", smtpPass: "p", smtpSecure: "yes" });
    expect((svc1 as any).platformSmtp.secure).toBe(true);
    expect((svc2 as any).platformSmtp.secure).toBe(true);
  });

  it("falls back to port 587 for a non-positive-integer SMTP_PORT", async () => {
    const svc = makeService({
      smtpHost: "h",
      smtpUser: "u",
      smtpPass: "p",
      smtpPort: "not-a-number",
    });
    expect((svc as any).platformSmtp.port).toBe(587);
  });

  it("falls back to port 587 for a negative or zero SMTP_PORT", async () => {
    const svc = makeService({ smtpHost: "h", smtpUser: "u", smtpPass: "p", smtpPort: "-1" });
    expect((svc as any).platformSmtp.port).toBe(587);
  });
});

describe("EmailService — B452 review fixes: addSendingDomain / getSendingDomainStatus with platform SMTP", () => {
  it("getSendingDomainStatus reports platformConfigured true when platform SMTP is active (no Resend)", async () => {
    const svc = makeService({ smtpHost: "h", smtpUser: "u", smtpPass: "p" });
    expect((await svc.getSendingDomainStatus()).platformConfigured).toBe(true);
  });

  it("addSendingDomain says own-domain sending is Resend-only when platform SMTP is active", async () => {
    const svc = makeService({ smtpHost: "h", smtpUser: "u", smtpPass: "p" });
    await expect(svc.addSendingDomain("mail.acme.com")).rejects.toThrow(/Resend-only/i);
  });

  it("addSendingDomain keeps the generic message when neither transport is configured", async () => {
    const svc = makeService();
    await expect(svc.addSendingDomain("mail.acme.com")).rejects.toThrow(/isn't set up yet/i);
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

/**
 * T-B102 / R8 / REG-B102 — send/reminder emails must carry the CONFIRMED-basis
 * `totalPaid`/`balanceDue` (not just the never-changes `total`) and render them in
 * the tfoot the same way the PDF's totals box shows Amount Paid / Balance Due. A
 * reminder must demand the outstanding BALANCE, never the stale total — dunning a
 * customer for the full $500 after they've already paid $300 is exactly the
 * "payment status lies" bug this campaign exists to kill.
 *
 * `sendInvoice`'s params type doesn't declare `totalPaid`/`balanceDue` yet, so the
 * calls below are cast `as any` — the assertions on the RENDERED html (not a TS
 * compile error) are what must go red.
 */
describe("EmailService.sendInvoice — payment truth (T-B102, R8, REG-B102)", () => {
  const baseParams = {
    to: "buyer@example.com",
    customerName: "Acme Buyer",
    invoiceNumber: "INV-2001",
    invoiceId: "inv-2001",
    issueDate: "Jan 1, 2026",
    dueDate: "Jan 31, 2026",
    total: 500,
    totalPaid: 300,
    balanceDue: 200,
    items: [{ description: "Widget", qty: 10, unitPrice: 50, subtotal: 500 }],
  };

  function tfootOf(html: string): string {
    return (html.match(/<tfoot>[\s\S]*?<\/tfoot>/) ?? [""])[0];
  }

  it("REG-B102: a non-reminder send's tfoot shows Amount Paid $300.00 AND Balance Due $200.00 on a $500 invoice with $300 confirmed", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({ ...baseParams, isReminder: false } as any);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("Amount Paid");
    expect(tfoot).toContain("$300.00");
    expect(tfoot).toContain("Balance Due");
    expect(tfoot).toContain("$200.00");
  });

  it("REG-B102: sendReminder (isReminder:true) demands the $200 balance in its tfoot, never the stale $500 total (mutation: total-as-balance)", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({ ...baseParams, isReminder: true } as any);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("$200.00");
    // Scoped to the DEMANDED-amount row, not the whole tfoot: R8 wants this footer
    // to mirror the PDF's totals box, and a correct one may legitimately also carry
    // a "Total $500.00" line. A bare `expect(tfoot).not.toContain("$500.00")` would
    // fail that correct build for the wrong reason. What must never happen is the
    // Balance Due row itself demanding the stale total.
    const balanceRow = (tfoot.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Balance Due[\s\S]*?<\/tr>/i) ?? [
      "",
    ])[0];
    expect(balanceRow).toContain("$200.00");
    expect(balanceRow).not.toContain("$500.00");
  });
});

/**
 * B421 — a CREDIT_NOTE/ADVANCE application must never render as "Amount
 * Paid" in an email sent to the customer. This is the client's exact
 * original complaint ("Paid $638.00" although they never paid anything),
 * reaching an email their own customer reads.
 */
describe("EmailService.sendInvoice — credit/advance never render as Amount Paid (REG-B421)", () => {
  const baseParams = {
    to: "buyer@example.com",
    customerName: "Acme Buyer",
    invoiceNumber: "INV-3001",
    invoiceId: "inv-3001",
    issueDate: "Jan 1, 2026",
    dueDate: "Jan 31, 2026",
    total: 870,
    items: [{ description: "Widget", qty: 1, unitPrice: 870, subtotal: 870 }],
  };

  function tfootOf(html: string): string {
    return (html.match(/<tfoot>[\s\S]*?<\/tfoot>/) ?? [""])[0];
  }

  it("REG-B421: a credit-only invoice's tfoot never contains a non-zero Amount Paid row, but does show Credit issued", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 232,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    // The exact pre-fix bug: "Amount Paid" next to the credit's own figure.
    // $638.00 legitimately appears in the tfoot — under "Credit issued", not
    // "Amount Paid" — so the real assertion is that no "Amount Paid" ROW
    // exists at all, never that the figure itself is absent.
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Credit issued");
    expect(tfoot).toContain("CN-1042");
    expect(tfoot).toContain("$638.00");
    expect(tfoot).toContain("Balance Due");
    expect(tfoot).toContain("$232.00");
  });

  it("REG-B421: a cash + credit invoice shows BOTH an Amount Paid row and a separate Credit issued row", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 232,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 0,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("Amount Paid");
    expect(tfoot).toContain("$232.00");
    expect(tfoot).toContain("Credit issued");
    expect(tfoot).toContain("$638.00");
  });

  it("REG-B421: same as the credit-only case, for a reminder send", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 232,
      isReminder: true,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Credit issued");
  });

  it("REG-B421: an advance-only invoice shows Advance applied, never Amount Paid", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 0,
      advanceApplied: 100,
      balanceDue: 770,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Advance applied");
    expect(tfoot).toContain("$100.00");
  });
});

/**
 * T-B103 / R9 / REG-B103 — PDF + email item payloads gain `originalPrice`,
 * `priceType`, `promoFreeUnits`; the email item row must show the struck-through
 * original price and an "N free" note on a BOGO line, mirroring the web invoice
 * detail renderer (apps/web/app/(dashboard)/invoices/[id]/page.tsx's
 * `{Number(item.promoFreeUnits)} free` text + `.strike` original-price markup —
 * email HTML has no external stylesheet, so the strike must be an inline
 * `text-decoration:line-through` or a semantic `<s>`/`<del>` tag instead of a CSS
 * class).
 *
 * Fixture: qty 6, 1 free unit, $10/unit, $12 original (pre-promo) — qty×unit−free
 * reconciles to the $50 stored subtotal: 10*(6-1) = 50, never the naive 10*6 = 60
 * a re-derive-from-qty bug would show.
 */
describe("EmailService.sendInvoice — BOGO/promo item display (T-B103, R9, REG-B103)", () => {
  const bogoItem = {
    description: "Widget (BOGO)",
    qty: 6,
    unitPrice: 10,
    subtotal: 50,
    originalPrice: 12,
    priceType: "PROMO",
    promoFreeUnits: 1,
  };

  function itemRowsOf(html: string): string {
    return (html.match(/<tbody>([\s\S]*?)<\/tbody>/) ?? ["", ""])[1];
  }

  it("REG-B103: the item row notes the free unit, strikes the original price, and keeps the $50 (not $60) subtotal", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      to: "buyer@example.com",
      customerName: "Acme Buyer",
      invoiceNumber: "INV-2002",
      invoiceId: "inv-2002",
      issueDate: "Jan 1, 2026",
      dueDate: "Jan 31, 2026",
      total: 50,
      totalPaid: 0,
      balanceDue: 50,
      items: [bogoItem],
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const row = itemRowsOf(html);

    // BUY_N_GET_M note — same wording as the web reference ("1 free").
    expect(row).toContain("1 free");
    // Struck-through original per-unit price ($12), via either a semantic <s>
    // tag or an inline text-decoration:line-through — checked as two independent
    // acceptable shapes rather than one brittle combined regex.
    const hasSTag = /<s[^>]*>[^<]*\$12\.00/i.test(row);
    const hasInlineStrike = /text-decoration:\s*line-through/i.test(row) && row.includes("$12.00");
    expect(hasSTag || hasInlineStrike).toBe(true);
    // Reconciliation: qty×unit − free = 10*(6-1) = $50, the stored subtotal —
    // never the naive qty×unit = $60 a re-derive-from-qty bug would show.
    expect(row).toContain("$50.00");
    expect(row).not.toContain("$60.00");
  });

  it("REG-B103: hideOriginalPrice suppresses the strike — the tenant's hidden pre-promo price never reaches the buyer", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      to: "buyer@example.com",
      customerName: "Acme Buyer",
      invoiceNumber: "INV-2003",
      invoiceId: "inv-2003",
      issueDate: "Jan 1, 2026",
      dueDate: "Jan 31, 2026",
      total: 50,
      totalPaid: 0,
      balanceDue: 50,
      items: [bogoItem],
      // The tenant set invoice.hideOriginalPrice — the PDF attached to this very
      // message and the web detail page both show $10 only. The body must agree.
      hideOriginalPrice: true,
    } as any);

    const row = itemRowsOf(sendSpy.mock.calls[0][0].html);

    // The $12 pre-promo price is gone in every shape it could take.
    expect(row).not.toContain("$12.00");
    expect(row).not.toMatch(/text-decoration:\s*line-through/i);
    // …but the line is otherwise unchanged: the free-unit note and the charged
    // price/subtotal still render (hiding the base price is not hiding the promo).
    expect(row).toContain("1 free");
    expect(row).toContain("$10.00");
    expect(row).toContain("$50.00");
  });
});

/**
 * N3 fix round (Opus review of 1dba2bca, finding 4): `sendPlatform()` must NEVER resolve
 * tenant SMTP or tenant branding, even though `makeService()`'s mocked `prisma.getTenantId()`
 * always returns "t1" here — exactly the in-request condition (a tenant admin's own
 * authenticated action, e.g. upgrade()/downgrade()) where `send()` WOULD pick up the
 * tenant's own mailbox. `sendPlatform` must be immune to that.
 */
describe("EmailService.sendPlatform — platform-only send, never tenant SMTP/branding", () => {
  const smtpRows = () => [
    { key: "email.smtpHost", value: "smtp.office365.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: "587" },
    { key: "email.smtpSecure", value: "false" },
  ];

  it("with the tenant's own SMTP configured AND Resend configured, sendPlatform uses Resend with the PLATFORM from-address — nodemailer is never even invoked", async () => {
    const svc = makeService({
      resendKey: "re_test",
      emailFrom: "RouteFlow <invoices@send.routeflow.info>",
      systemConfigRows: smtpRows(), // the tenant's own SMTP IS configured
      tenantConfig: { businessName: "Acme Retail" }, // and tenant branding IS available
    });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: { id: "eml_1" }, error: null });
    // `nodemailer` is one jest.mock() shared across this whole file, so its call count
    // accumulates across tests — snapshot-and-diff instead of `.not.toHaveBeenCalled()`.
    const nodemailerCallsBefore = (nodemailer.createTransport as jest.Mock).mock.calls.length;

    const res = await svc.sendPlatform({ to: "admin@acme.test", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "resend", id: "eml_1" });
    expect((nodemailer.createTransport as jest.Mock).mock.calls.length).toBe(nodemailerCallsBefore); // tenant SMTP never touched
    expect((svc as any).resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ from: "RouteFlow <invoices@send.routeflow.info>" }), // platform from, not Acme Retail's
    );
  });

  it("Resend rejecting the message returns delivered:false, transport:'resend'", async () => {
    const svc = makeService({
      resendKey: "re_test",
      emailFrom: "RouteFlow <invoices@send.routeflow.info>",
    });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "domain not verified" } });

    const res = await svc.sendPlatform({ to: "admin@acme.test", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({
      delivered: false,
      transport: "resend",
      error: "domain not verified",
    });
  });

  it("no Resend configured ⇒ delivered:false, transport:'none' — never falls back to tenant SMTP even if one is configured", async () => {
    const svc = makeService({ systemConfigRows: smtpRows() }); // no resendKey, but tenant SMTP IS configured
    const nodemailerCallsBefore = (nodemailer.createTransport as jest.Mock).mock.calls.length;

    const res = await svc.sendPlatform({ to: "admin@acme.test", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: false, transport: "none" });
    expect((nodemailer.createTransport as jest.Mock).mock.calls.length).toBe(nodemailerCallsBefore);
  });

  it("threads the optional text param through to Resend", async () => {
    const svc = makeService({
      resendKey: "re_test",
      emailFrom: "RouteFlow <invoices@send.routeflow.info>",
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_1" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    await svc.sendPlatform({
      to: "admin@acme.test",
      subject: "x",
      html: "<p>x</p>",
      text: "plain text body",
    });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "plain text body" }));
  });
});
