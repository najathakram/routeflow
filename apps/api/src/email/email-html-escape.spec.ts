import { Logger } from "@nestjs/common";
import { refusedEmailLinkCount } from "../common/html-escape";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * B807 (REG-B807) — tenant- and buyer-entered text must never reach an HTML email body
 * unescaped. email.service.ts built invoice, merge and SMTP-test emails by interpolating
 * descriptions, customer names, invoice numbers, terms, dates and emails straight into HTML.
 */

// The STRUCTURAL guard that used to live here (an email.service-only scan keyed by expression
// text) is superseded by common/html-interpolation.spec.ts (B809): every api file, keyed by
// location, following values through consts, parameters and call sites.

// ─── Behavioral pins: a <script> payload in each field arrives escaped ─────────────────────────

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

function makeService(): EmailService {
  const config = { get: () => undefined } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const mailboxSend = {
    trySend: jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" }),
  } as any;
  return new EmailService(config, prisma, { decrypt: (v: string) => v } as any, mailboxSend, {
    record: jest.fn(),
  } as any);
}

/** The HTML of every send() the service makes, with delivery stubbed out. */
function captureHtml(svc: EmailService): string[] {
  const htmls: string[] = [];
  jest.spyOn(svc, "send").mockImplementation(async (p: any) => {
    htmls.push(p.html);
    return { delivered: true, transport: "smtp" } as any;
  });
  return htmls;
}

const expectEscaped = (html: string) => {
  expect(html).not.toContain("<script>");
  expect(html).toContain(ESCAPED);
};

describe("B807 — each tenant/buyer field is HTML-escaped in its email (REG-B807)", () => {
  const invoice = (over: Record<string, unknown>) => ({
    customerName: "Acme Market",
    invoiceNumber: "INV-1001",
    issueDate: "Sep 1, 2026",
    dueDate: "Sep 30, 2026",
    paymentTermsLabel: "Net 30",
    total: 12,
    items: [{ description: "Sample Cola 12pk", qty: 1, unitPrice: 12, subtotal: 12 }],
    pdfUrl: "https://files.example.com/inv.pdf",
    depositAmount: 5,
    depositDueDate: "Sep 10, 2026",
    creditApplied: 2,
    creditNoteNumbers: ["CN-1"],
    balanceDue: 10,
    ...over,
  });
  const buildInvoiceHtml = (over: Record<string, unknown>) =>
    (makeService() as any).buildInvoiceEmail(invoice(over), "Acme Supply").html as string;

  it.each([
    ["line description", { items: [{ description: XSS, qty: 1, unitPrice: 12, subtotal: 12 }] }],
    ["customerName", { customerName: XSS }],
    ["invoiceNumber", { invoiceNumber: XSS }],
    ["paymentTermsLabel", { paymentTermsLabel: XSS }],
    ["issueDate", { issueDate: XSS }],
    ["dueDate", { dueDate: XSS }],
    ["depositDueDate", { depositDueDate: XSS }],
    ["creditNoteNumbers", { creditNoteNumbers: [XSS] }],
  ])("invoice email: %s", (_field, over) => {
    expectEscaped(buildInvoiceHtml(over));
  });

  it("invoice email: a business name that ends in a period gets no second one in the footer (CQ-20)", () => {
    const built = (makeService() as any).buildInvoiceEmail(invoice({}), "Acme Co.") as {
      html: string;
      text: string;
    };
    expect(built.text).toContain("This is an automated email from Acme Co.");
    expect(built.text).not.toContain("Acme Co..");
    expect(built.html).not.toContain("Acme Co..");
  });

  it('invoice email: pdfUrl cannot break out of its href (a `"` is escaped)', () => {
    const html = buildInvoiceHtml({ pdfUrl: `https://x.example/a"><script>alert("x")</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://x.example/a&quot;&gt;&lt;script&gt;');
  });

  it("merge verification email: primaryEmail and to", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    await svc.sendMergeVerificationEmail({
      to: XSS,
      primaryEmail: XSS,
      verifyUrl: "https://app.example.com/v?t=1&u=2",
    });
    expectEscaped(htmls[0]);
    expect(htmls[0].split(ESCAPED)).toHaveLength(3); // both fields
    expect(htmls[0]).toContain('href="https://app.example.com/v?t=1&amp;u=2"');
  });

  it("merge complete emails: primaryEmail, secondaryEmail and the buyer's own name", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    await svc.sendMergeCompleteEmail({ primaryEmail: XSS, secondaryEmail: XSS, primaryName: XSS });
    expect(htmls).toHaveLength(2);
    for (const html of htmls) expectEscaped(html);
  });

  it("SMTP test email: the tenant business name", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    jest.spyOn(svc as any, "getTenantBusinessName").mockResolvedValue(XSS);
    await svc.sendTestEmail("owner@example.com");
    expectEscaped(htmls[0]);
  });

  it("mailbox revoked notice (F-10a): the connected mailbox address and the admin's username", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    await svc.sendMailboxRevokedNotice({
      to: "owner@example.com",
      username: XSS,
      accountEmail: XSS,
      provider: "GOOGLE",
      hasFallback: true,
    });
    expectEscaped(htmls[0]);
    // 4 escaped copies: the greeting + the three paragraphs that name the mailbox.
    expect(htmls[0].split(ESCAPED)).toHaveLength(5);
  });
});

/** sendSetPasswordEmail sends through sendPlatform, not send: capture that path. */
function capturePlatformHtml(svc: EmailService): string[] {
  const htmls: string[] = [];
  jest.spyOn(svc, "sendPlatform").mockImplementation(async (p: any) => {
    htmls.push(p.html);
    return { delivered: true, transport: "smtp" } as any;
  });
  return htmls;
}

describe("B809 — the CTA button refuses a non-http(s) link, and the email still goes out (REG-B809)", () => {
  it("sendSetPasswordEmail with a javascript: URL sends the email with NO link and logs an error", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const before = refusedEmailLinkCount();
    const svc = makeService();
    const htmls = capturePlatformHtml(svc);
    await svc.sendSetPasswordEmail({
      to: "new.user@example.com",
      username: "newuser",
      setPasswordUrl: "javascript:alert(1)",
      expiryHours: 72,
    });
    expect(htmls).toHaveLength(1); // the email still went out
    expect(htmls[0]).not.toContain("javascript:");
    expect(htmls[0]).not.toMatch(/<a [^>]*>Set your password</);
    expect(htmls[0]).toMatch(/<span [^>]*>Set your password<\/span>/);
    expect(refusedEmailLinkCount()).toBe(before + 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^renderBrandButton: refused/));
    errorSpy.mockRestore();
  });

  it("an https URL still renders as the button's href", async () => {
    const svc = makeService();
    const htmls = capturePlatformHtml(svc);
    await svc.sendSetPasswordEmail({
      to: "new.user@example.com",
      username: "newuser",
      setPasswordUrl: "https://app.example.com/reset-password?token=ab12",
      expiryHours: 72,
    });
    expect(htmls[0]).toContain('href="https://app.example.com/reset-password?token=ab12"');
  });
});
