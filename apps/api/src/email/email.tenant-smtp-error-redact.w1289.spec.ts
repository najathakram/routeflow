import { BadRequestException } from "@nestjs/common";
import type { AccountStatement } from "@routeflow/types";
import { EmailService } from "./email.service";
import { sendCustomerStatementEmail } from "../customers/customer-statement-email";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));
import * as nodemailer from "nodemailer";

const mockBuild = jest.fn();
jest.mock("../customers/account-statement", () => ({
  ...jest.requireActual("../customers/account-statement"),
  buildAccountStatement: (...a: unknown[]) => mockBuild(...a),
}));

/**
 * W-1289: a tenant's own mail server refuses a send; its raw reply (a recipient address and a server IP) must not reach
 * the staff user's red error. Every transport's `result.error` is redacted the same way. Dummy data only (acme.test).
 */
const RAW = "550 5.1.1 <jane.doe@acme.test>: Recipient address rejected (client 203.0.113.7)";
const MASKED = "550 5.1.1 <***@acme.test>: Recipient address rejected (client [address])";

const TENANT_SMTP_ROWS = [
  { key: "email.smtpHost", value: "smtp.example.com" },
  { key: "email.smtpUser", value: "user@example.com" },
  { key: "email.smtpPassword", value: "pw" },
  { key: "email.smtpPort", value: "587" },
];

function make(opts: { platformSmtp: boolean }) {
  const env: Record<string, string | undefined> = {
    SMTP_HOST: opts.platformSmtp ? "smtp.platform.test" : undefined,
    SMTP_PORT: opts.platformSmtp ? "587" : undefined,
    SMTP_USER: opts.platformSmtp ? "platform@example.com" : undefined,
    SMTP_PASS: opts.platformSmtp ? "pw" : undefined,
  };
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(TENANT_SMTP_ROWS),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  (nodemailer.createTransport as jest.Mock).mockImplementation((o: any) => ({
    sendMail:
      o.host === "smtp.example.com"
        ? jest.fn().mockRejectedValue(new Error(RAW))
        : jest.fn().mockRejectedValue(new Error("platform down")),
  }));
  const mailbox = {
    trySend: jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" }),
  };
  const svc = new EmailService(
    { get: (k: string) => env[k] } as any,
    prisma,
    { decrypt: (v: string) => v } as any,
    mailbox as any,
    { record: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
  );
  return svc;
}

const mail = { to: "buyer@example.com", subject: "s", html: "<p>x</p>" };

beforeEach(() => jest.clearAllMocks());

describe("W-1289: tenant SMTP error is redacted in result.error", () => {
  it("T1: tenant SMTP fails, platform SMTP fails", async () => {
    const svc = make({ platformSmtp: true });
    const res = await svc.send(mail);
    expect(res.delivered).toBe(false);
    expect(res.error).toEqual(MASKED);
  });

  it("T2: tenant SMTP fails, no platform transport", async () => {
    const svc = make({ platformSmtp: false });
    const res = await svc.send(mail);
    expect(res.delivered).toBe(false);
    expect(res.transport).toBe("smtp");
    expect(res.error).toEqual(MASKED);
  });

  it("T3: the statement 400 carries the masked text", async () => {
    const svc = make({ platformSmtp: false });
    mockBuild.mockResolvedValue({
      asOf: "2026-10-31",
      customer: { id: "cust-1", businessName: "Acme Corp" },
      emailOnFile: null,
      openBalance: 0,
      overdue: 0,
      creditAvailable: 0,
      afterCredit: 0,
      waitingToClear: 0,
      openInvoices: [],
      recentPayments: [],
      recentPaymentsTruncated: false,
      credits: [],
    } as AccountStatement);
    const deps = {
      prisma: {
        forTenant: () => ({
          customer: {
            findFirst: jest.fn().mockResolvedValue({
              id: "cust-1",
              businessName: "Acme Corp",
              email: "ap@acme.test",
            }),
          },
        }),
        getTenantId: () => "t1",
      },
      emailService: { isEmailConfigured: async () => true, send: svc.send.bind(svc) },
      statementPdf: {
        loadTenant: jest.fn().mockResolvedValue({ businessName: "Acme Corp" }),
        renderCurrent: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")),
      },
    } as any;
    const err = await sendCustomerStatementEmail(deps, "cust-1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message: `The statement couldn't be emailed (${MASKED}). Check your email settings under Settings → Email and try again.`,
    });
  });

  it("T4: the log line still carries the fallback wording", async () => {
    const svc = make({ platformSmtp: false });
    const spy = jest.spyOn((svc as any).logger, "error").mockImplementation(() => undefined);
    await svc.send(mail);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes("Falling back to Resend. Mapped reason:")),
    ).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("jane.doe"))).toBe(false);
  });
});
