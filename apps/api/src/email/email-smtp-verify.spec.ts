import { EmailService, mapSmtpError } from "./email.service";
import * as nodemailer from "nodemailer";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * Per-tenant SMTP verification — the pre-save connection check that makes BYO-SMTP
 * self-service: a real handshake with the candidate settings, and provider-aware
 * plain-language guidance for the failures tenants actually hit (Gmail app
 * passwords, Microsoft 365's disabled-by-default SMTP auth, wrong port/TLS).
 */
function makeService(opts: { systemConfigRows?: any[]; tenantConfig?: any } = {}): EmailService {
  const config = { get: () => undefined } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(opts.systemConfigRows ?? []),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(opts.tenantConfig ?? null) },
  } as any;
  const encryption = { decrypt: (v: string) => v } as any;
  return new EmailService(config, prisma, encryption);
}

const mockTransport = (verify: jest.Mock) =>
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ verify });

describe("mapSmtpError — provider-aware guidance", () => {
  it("maps Microsoft 365 disabled SMTP auth to the admin-center fix", () => {
    const msg = mapSmtpError(
      { message: "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled" },
      "smtp.office365.com",
      587,
    );
    expect(msg).toMatch(/Authenticated SMTP/);
    expect(msg).toMatch(/admin center/i);
  });

  it("maps the Gmail app-password rejection to the app-password fix", () => {
    const msg = mapSmtpError(
      { message: "534-5.7.9 Application-specific password required" },
      "smtp.gmail.com",
      587,
    );
    expect(msg).toMatch(/App Password/i);
    expect(msg).toMatch(/apppasswords/);
  });

  it("adds the Gmail hint to a generic auth failure on a gmail host", () => {
    const msg = mapSmtpError(
      { code: "EAUTH", message: "535-5.7.8 Username and Password not accepted" },
      "smtp.gmail.com",
      587,
    );
    expect(msg).toMatch(/App Password/i);
  });

  it("maps a timeout to host/port guidance with the STARTTLS/SSL pairs", () => {
    const msg = mapSmtpError(
      { code: "ETIMEDOUT", message: "connect ETIMEDOUT" },
      "mail.x.com",
      465,
    );
    expect(msg).toMatch(/mail\.x\.com:465/);
    expect(msg).toMatch(/587/);
  });

  it("maps an unknown-host failure to a host-name check", () => {
    const msg = mapSmtpError(
      { code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.wrong.com" },
      "smtp.wrong.com",
      587,
    );
    expect(msg).toMatch(/couldn't be found/);
  });

  it("maps a TLS mismatch to the port/secure pairing fix", () => {
    const msg = mapSmtpError({ message: "wrong version number (SSL routines)" }, "mail.x.com", 465);
    expect(msg).toMatch(/587/);
    expect(msg).toMatch(/465/);
  });

  it("redacts a resolved internal IP from an uncovered-code fallback (no network probe leak)", () => {
    const msg = mapSmtpError(
      { code: "EHOSTUNREACH", message: "connect EHOSTUNREACH 10.0.1.4:587" },
      "mail.internal.example",
      587,
    );
    expect(msg).not.toMatch(/10\.0\.1\.4/);
    expect(msg).toMatch(/\[address\]/);
  });

  it("redacts an IPv6 literal from a fallback message too", () => {
    const msg = mapSmtpError(
      { code: "ENETUNREACH", message: "connect ENETUNREACH fd00::1234:587" },
      "mail.internal.example",
      587,
    );
    expect(msg).not.toMatch(/fd00::1234/);
    expect(msg).toMatch(/\[address\]/);
  });
});

describe("EmailService.verifySmtpConnection", () => {
  beforeEach(() => (nodemailer.createTransport as jest.Mock).mockReset());

  it("returns ok:true when the handshake succeeds", async () => {
    mockTransport(jest.fn().mockResolvedValue(true));
    const res = await makeService().verifySmtpConnection({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      user: "a@gmail.com",
      password: "app-pass",
    });
    expect(res.ok).toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.gmail.com", port: 587, secure: false }),
    );
  });

  it("returns a mapped failure (never throws) when the handshake fails", async () => {
    mockTransport(
      jest
        .fn()
        .mockRejectedValue(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })),
    );
    const res = await makeService().verifySmtpConnection({
      host: "mail.x.com",
      port: 465,
      secure: true,
      user: "a@x.com",
      password: "pw",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/mail\.x\.com:465/);
  });

  it("rejects an SSRF-blocked host as a friendly failure, without connecting", async () => {
    const res = await makeService().verifySmtpConnection({
      host: "169.254.169.254",
      port: 587,
      user: "a@x.com",
      password: "pw",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not permitted/);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it("asks for the missing fields instead of connecting with a blank config", async () => {
    const res = await makeService().verifySmtpConnection({ host: "", user: "", password: "" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/host, email address, and password/i);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it("falls back to the SAVED password for the same mailbox+server when blank", async () => {
    const verify = jest.fn().mockResolvedValue(true);
    mockTransport(verify);
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.gmail.com" },
        { key: "email.smtpUser", value: "a@gmail.com" },
        { key: "email.smtpPassword", value: "saved-pass" },
        { key: "email.smtpPort", value: "587" },
      ],
    });
    const res = await svc.verifySmtpConnection({
      host: "smtp.gmail.com",
      port: 587,
      user: "a@gmail.com",
      password: "",
    });
    expect(res.ok).toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "a@gmail.com", pass: "saved-pass" } }),
    );
  });

  it("does NOT replay the saved password against a DIFFERENT host", async () => {
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.gmail.com" },
        { key: "email.smtpUser", value: "a@gmail.com" },
        { key: "email.smtpPassword", value: "saved-pass" },
      ],
    });
    const res = await svc.verifySmtpConnection({
      host: "smtp.attacker.com",
      port: 587,
      user: "a@gmail.com",
      password: "",
    });
    expect(res.ok).toBe(false);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
