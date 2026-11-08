import { Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import { portalInviteEmail } from "../customers/portal-invite-email";
import { paragraphsMissingFromText } from "../testing/email-text-parity";
import { isLayoutHtml } from "./email-layout";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * W-1163 PR-2 review pins (owner rules: tenant mail wears the tenant's look with "Sent with
 * RouteFlow", never RouteFlow's mark; no Reply-To is added). Acme placeholders only.
 */

const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");

function service(tenantId: string | null = "t1", businessName: string | null = "Acme Foods") {
  const env: Record<string, string> = {
    SMTP_HOST: "smtp.test",
    SMTP_USER: "u@t.test",
    SMTP_PASS: "pw",
  };
  const prisma = {
    getTenantId: () => tenantId,
    tenantConfig: { findFirst: jest.fn().mockResolvedValue({ businessName }) },
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
  const svc = new EmailService(
    { get: (k: string) => env[k] } as any,
    prisma,
    { decrypt: (v: string) => v } as any,
    { trySend: jest.fn().mockResolvedValue({ delivered: false }) } as any,
    { record: jest.fn() } as any,
    {} as any,
  );
  return { svc, sendMail };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("the buyer-portal invite: tenant look, platform transport (#824)", () => {
  const INVITE_URL = "https://app.test/buyer/invite/" + "a".repeat(64);

  it("sent as a platform send it wears the tenant's look, never RouteFlow's mark, and logs no drop", async () => {
    const { svc, sendMail } = service();
    const look = await svc.tenantLook();
    expect(look).toMatchObject({ kind: "tenant", name: "Acme Foods" });
    await svc.send({
      to: "buyer@acme.example",
      ...portalInviteEmail("Acme Foods", INVITE_URL, look),
      senderClass: "platform",
    });
    const sent = sendMail.mock.calls[0][0];
    expect(isLayoutHtml(sent.html)).toBe(true);
    expect(sent.html).not.toMatch(/alt="RouteFlow"|routeflow-mark/);
    expect(visible(sent.html)).toContain("Acme Foods");
    expect(visible(sent.html)).toContain("Sent with RouteFlow");
    expect(visible(sent.html)).toContain("This link expires in 7 days.");
    // the token is the button's target, never visible text
    expect(sent.html).toContain(`href="${INVITE_URL}"`);
    expect(visible(sent.html)).not.toContain("a".repeat(64));
    // no Reply-To, and the platform guard has nothing to complain about (finished html, no layout)
    expect(sent.replyTo).toBeUndefined();
    const errors = (Logger.prototype.error as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(errors.filter((m) => m.includes("platform path drops"))).toEqual([]);
  });

  it("the text part carries the link and the expiry line", () => {
    const m = portalInviteEmail("Acme Foods", INVITE_URL, { kind: "tenant", name: "Acme Foods" });
    expect(m.text).toContain(INVITE_URL);
    expect(m.text).toContain("This link expires in 7 days.");
  });

  it("escapes a hostile business name, and the text part says what the html says", () => {
    const m = portalInviteEmail("<b>Acme</b> & Co", INVITE_URL, {
      kind: "tenant",
      name: "<b>Acme</b> & Co",
    });
    expect(m.html).not.toContain("<b>Acme</b>");
    expect(m.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(paragraphsMissingFromText(m.html, m.text)).toEqual([]);
  });
});

describe("the platform sender drops `layout` and attachments: it says so", () => {
  const platform = {
    to: "admin@acme.example",
    subject: "Hi",
    html: "<p>x</p>",
    senderClass: "platform" as const,
  };

  it("logs an ERROR when a platform send is given a layout spec", async () => {
    const { svc } = service();
    await svc.send({ ...platform, layout: { heading: "H", footerNote: "why" } });
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("platform path drops"),
    );
  });

  it("logs an ERROR when a platform send is given attachments", async () => {
    const { svc } = service();
    await svc.send({
      ...platform,
      attachments: [{ filename: "a.pdf", content: Buffer.from("x") }],
    });
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("platform path drops"),
    );
  });

  it("a plain platform send logs nothing about it", async () => {
    const { svc } = service();
    await svc.send({ ...platform, html: "<!--rf-email-layout-->" });
    const calls = (Logger.prototype.error as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((m) => m.includes("platform path drops"))).toEqual([]);
  });
});

describe("the low-stock digest wears the tenant's look", () => {
  const items = [{ name: "Acme Widget", sku: "WID-001", currentStock: 3, reorderPoint: 10 }];

  it("a named tenant: its name, 'Sent with RouteFlow', no 'RouteFlow Platform'", async () => {
    const { svc } = service(null);
    const send = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);
    await svc.sendLowStockDigest({ to: "a@acme.example", businessName: "Acme Foods", items });
    const sent = send.mock.calls[0][0];
    expect(isLayoutHtml(sent.html)).toBe(true);
    expect(visible(sent.html)).toContain("Acme Foods");
    expect(visible(sent.html)).toContain("Sent with RouteFlow");
    expect(sent.html).not.toMatch(/alt="RouteFlow"|routeflow-mark/);
    expect(`${sent.html} ${sent.text}`).not.toContain("RouteFlow Platform");
    expect(sent.text).toContain("Acme Widget");
  });

  it.each([[null], [""], ["  "]])(
    "an unnamed tenant (%j) is neutral: never RouteFlow's name, no 'Sent with'",
    async (name) => {
      const { svc } = service(null);
      const send = jest
        .spyOn(svc, "send")
        .mockResolvedValue({ delivered: true, transport: "resend" } as any);
      await svc.sendLowStockDigest({ to: "a@acme.example", businessName: name, items });
      const sent = send.mock.calls[0][0];
      expect(isLayoutHtml(sent.html)).toBe(true);
      expect(sent.html).not.toMatch(/alt="RouteFlow"|routeflow-mark/);
      expect(visible(sent.html)).not.toContain("Sent with");
      expect(visible(sent.html)).not.toMatch(/RouteFlow/);
      expect(sent.text).not.toMatch(/RouteFlow/);
    },
  );
});

describe("no Reply-To is added to a composed tenant mail", () => {
  it("composeLayout and the guard add no replyTo; the transport gets none", async () => {
    const { svc, sendMail } = service();
    await svc.send({
      to: "buyer@acme.example",
      subject: "Hi",
      html: "<p>body</p>",
      layout: { heading: "H", footerNote: "why" },
    });
    expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
  });
});
