import { EmailService } from "./email.service";
import { MailboxSendService } from "./mailbox/mailbox-send.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: "re_1" }, error: null }),
    },
  })),
}));
import * as nodemailer from "nodemailer";
import { newDeliveryRefToken } from "./bounces/email-bounce-keys";

// Module boundary for the random per-send ref token: real by default, forced in the case that needs a known value.
jest.mock("./bounces/email-bounce-keys", () => {
  const actual = jest.requireActual("./bounces/email-bounce-keys");
  return { ...actual, newDeliveryRefToken: jest.fn(actual.newDeliveryRefToken) };
});

/**
 * W-1286 PR-1 (SA-1202 C5, C4', C6, C29): every recorded send says which route it took (`route`), carries a per-send
 * reference header (`X-Delivery-Ref`, stored as `refToken`), and a tenant-server failure that falls back keeps its
 * class (`fallbackReason`) and nothing the provider wrote. The delivery writer is the module boundary, mocked.
 */
const TENANT_SMTP_ROWS = [
  { key: "email.smtpHost", value: "smtp.example.com" },
  { key: "email.smtpUser", value: "user@example.com" },
  { key: "email.smtpPassword", value: "pw" },
  { key: "email.smtpPort", value: "587" },
];

function make(
  opts: {
    tenantSmtp?: boolean;
    platformSmtp?: boolean;
    resend?: boolean;
    mailbox?: { trySend: jest.Mock };
    tenantSend?: jest.Mock;
    platformSend?: jest.Mock;
  } = {},
) {
  const env: Record<string, string | undefined> = {
    RESEND_API_KEY: opts.resend ? "re_test" : undefined,
    SMTP_HOST: opts.platformSmtp ? "smtp.platform.test" : undefined,
    SMTP_PORT: opts.platformSmtp ? "587" : undefined,
    SMTP_USER: opts.platformSmtp ? "platform@example.com" : undefined,
    SMTP_PASS: opts.platformSmtp ? "pw" : undefined,
  };
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(opts.tenantSmtp ? TENANT_SMTP_ROWS : []),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const tenantSend = opts.tenantSend ?? jest.fn().mockResolvedValue({ messageId: "<T@tenant>" });
  const platformSend =
    opts.platformSend ?? jest.fn().mockResolvedValue({ messageId: "<P@platform>" });
  (nodemailer.createTransport as jest.Mock).mockImplementation((o: any) => ({
    sendMail: o.host === "smtp.example.com" ? tenantSend : platformSend,
  }));
  const mailbox =
    opts.mailbox ??
    ({ trySend: jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" }) } as any);
  const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new EmailService(
    { get: (k: string) => env[k] } as any,
    prisma,
    { decrypt: (v: string) => v } as any,
    mailbox,
    deliveries as any,
    {} as any,
  );
  return { svc, deliveries, tenantSend, platformSend, mailbox };
}

// Fake only Date: every timer and microtask API stays real so the awaited send still settles.
const REAL_TIMERS = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;
const ctx = { tenantId: "t1", kind: "INVOICE_SENT" as const };
const mail = { to: "buyer@example.com", subject: "s", html: "<p>x</p>" };
const row = (d: { record: jest.Mock }) => d.record.mock.calls[0][0];

beforeEach(() => jest.clearAllMocks());

describe("C5: send() records the route it took", () => {
  it("tenant SMTP: route tenant-smtp, transport still 'smtp'", async () => {
    const { svc, deliveries } = make({ tenantSmtp: true });
    const res = await svc.send({ ...mail, delivery: ctx });
    expect(res.transport).toBe("smtp");
    expect(res.route).toBe("tenant-smtp");
    expect(row(deliveries).route).toBe("tenant-smtp");
  });

  it("T1: a tenant server that fails and falls back to the platform sender is platform-smtp", async () => {
    const tenantSend = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("nope"), { code: "EAUTH" }));
    const { svc, deliveries } = make({ tenantSmtp: true, platformSmtp: true, tenantSend });
    const res = await svc.send({ ...mail, delivery: ctx });
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe("smtp"); // both SMTP paths say "smtp": it is never the route
    expect(res.route).toBe("platform-smtp");
    expect(row(deliveries).route).toBe("platform-smtp");
  });

  it("a connected mailbox: route mailbox", async () => {
    const mailbox = {
      trySend: jest.fn().mockResolvedValue({ delivered: true, transport: "mailbox", id: "g1" }),
    };
    const { svc, deliveries } = make({ mailbox });
    await svc.send({ ...mail, delivery: ctx });
    expect(row(deliveries).route).toBe("mailbox");
  });

  it("Resend: route resend", async () => {
    const { svc, deliveries } = make({ resend: true });
    await svc.send({ ...mail, delivery: ctx });
    expect(row(deliveries).route).toBe("resend");
  });

  it("no transport configured: route none", async () => {
    const { svc, deliveries } = make();
    await svc.send({ ...mail, delivery: ctx });
    expect(row(deliveries).route).toBe("none");
  });

  it("a platform-class send (senderClass platform) through send() is platform-smtp", async () => {
    const { svc, deliveries } = make({ platformSmtp: true });
    await svc.send({ ...mail, senderClass: "platform", delivery: ctx });
    expect(row(deliveries).route).toBe("platform-smtp");
  });
});

describe("a thrown internal error reaches the caller without an address", () => {
  it("send() result.error is redacted when the pipeline throws", async () => {
    const mailbox = {
      trySend: jest.fn().mockRejectedValue(new Error("boom for private.person@example.org here")),
    };
    const { svc } = make({ mailbox });
    const res = await svc.send({ ...mail, delivery: ctx });
    expect(res.delivered).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain("private.person@example.org");
  });
});

describe("C29 / T30: the fallback keeps its class and nothing else", () => {
  it("a tenant-SMTP login failure that falls back stores AUTH, no provider text, no address", async () => {
    const tenantSend = jest.fn().mockRejectedValue(
      Object.assign(
        new Error("535 5.7.8 Username and Password not accepted for jane@example.com"),
        {
          code: "EAUTH",
          responseCode: 535,
        },
      ),
    );
    // A random hex token can contain "535" by chance (about 0.7% of runs); force it so the case is deterministic.
    (newDeliveryRefToken as jest.Mock).mockReturnValueOnce("af37a70b42342a132e5354bfb0646683");
    // sentAt is new Date() in the product: a ".535Z" millisecond part also trips the scan (about 1 run in 1000), so pin Date too.
    jest.useFakeTimers({ now: new Date("2026-11-25T02:12:03.535Z"), doNotFake: [...REAL_TIMERS] });
    const { svc, deliveries } = make({ tenantSmtp: true, platformSmtp: true, tenantSend });
    try {
      await svc.send({ ...mail, delivery: ctx });
    } finally {
      jest.useRealTimers();
    }
    const r = row(deliveries);
    expect(r.fallbackReason).toBe("AUTH");
    // Row fields and whether each can ever hold "535": tenantId, kind, toAddress, status, providerMessageId, route,
    // fallbackReason, error, attempts and alsoEntityIds are fixed or derived from fixed input, so they are scanned.
    // refToken (random hex) and sentAt (new Date(), ISO milliseconds) are the only random or time-derived fields:
    // both are left out of the scan and asserted by type instead.
    const { refToken, sentAt, ...rest } = r;
    expect(refToken).toMatch(/^[0-9a-f]{32}$/);
    expect(sentAt).toBeInstanceOf(Date);
    expect(JSON.stringify(rest)).not.toMatch(/535|Username|jane@/);
  });

  it("a send that never tried a tenant server stores no fallbackReason", async () => {
    const { svc, deliveries } = make({ platformSmtp: true });
    await svc.send({ ...mail, delivery: ctx });
    expect(row(deliveries).fallbackReason ?? null).toBeNull();
  });
});

describe("C4': the reference header on every recorded send", () => {
  it("T31a: tenant SMTP carries the header and stores the same token", async () => {
    const { svc, deliveries, tenantSend } = make({ tenantSmtp: true });
    await svc.send({ ...mail, delivery: ctx });
    const token = row(deliveries).refToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(tenantSend.mock.calls[0][0].headers).toEqual({ "X-Delivery-Ref": token });
  });

  it("T31a: platform SMTP carries the header and stores the same token", async () => {
    const { svc, deliveries, platformSend } = make({ platformSmtp: true });
    await svc.send({ ...mail, delivery: ctx });
    const token = row(deliveries).refToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(platformSend.mock.calls[0][0].headers).toEqual({ "X-Delivery-Ref": token });
  });

  it("T31a: the connected mailbox gets the header and stores the same token", async () => {
    const trySend = jest
      .fn()
      .mockResolvedValue({ delivered: true, transport: "mailbox", id: "g1" });
    const { svc, deliveries } = make({ mailbox: { trySend } });
    await svc.send({ ...mail, delivery: ctx });
    const token = row(deliveries).refToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(trySend.mock.calls[0][1].headers).toEqual({ "X-Delivery-Ref": token });
  });

  it("T31a: Resend gets the header and stores the same token", async () => {
    const { svc, deliveries } = make({ resend: true });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "re_9" }, error: null });
    (svc as any).resend.emails.send = sendSpy;
    await svc.send({ ...mail, delivery: ctx });
    const token = row(deliveries).refToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(sendSpy.mock.calls[0][0].headers).toEqual({ "X-Delivery-Ref": token });
  });

  it("T32a: an unrecorded send carries no header on any transport", async () => {
    const trySend = jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" });
    const a = make({ tenantSmtp: true, mailbox: { trySend } });
    await a.svc.send(mail);
    expect(a.tenantSend.mock.calls[0][0]).not.toHaveProperty("headers");
    expect(trySend.mock.calls[0][1]).not.toHaveProperty("headers");
    const b = make({ platformSmtp: true });
    await b.svc.send(mail);
    expect(b.platformSend.mock.calls[0][0]).not.toHaveProperty("headers");
    const c = make({ resend: true });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "re_9" }, error: null });
    (c.svc as any).resend.emails.send = sendSpy;
    await c.svc.send(mail);
    expect(sendSpy.mock.calls[0][0]).not.toHaveProperty("headers");
    expect(c.deliveries.record).not.toHaveBeenCalled();
  });

  it("T33a: two sends get two different tokens, and a token is never a row id", async () => {
    const { svc, deliveries } = make({ platformSmtp: true });
    await svc.send({ ...mail, delivery: ctx });
    await svc.send({ ...mail, delivery: ctx });
    const [a, b] = deliveries.record.mock.calls.map((c: any[]) => c[0].refToken);
    expect(a).not.toBe(b);
    for (const t of [a, b]) expect(t).toMatch(/^[0-9a-f]{32}$/); // a uuid has dashes
  });

  it("a platform-class send keeps the header too (sendPlatform path)", async () => {
    const { svc, deliveries, platformSend } = make({ platformSmtp: true });
    await svc.send({ ...mail, senderClass: "platform", delivery: ctx });
    expect(platformSend.mock.calls[0][0].headers).toEqual({
      "X-Delivery-Ref": row(deliveries).refToken,
    });
  });
});

describe("the mailbox MIME carries the header (T31a, fourth transport)", () => {
  it("buildMimeBuffer writes X-Delivery-Ref into the message, and none when absent", async () => {
    const build = (MailboxSendService.prototype as any).buildMimeBuffer;
    const base = { from: "a@example.com", to: "b@example.com", subject: "s", html: "<p>x</p>" };
    const withRef = (await build.call(
      {},
      { ...base, headers: { "X-Delivery-Ref": "c".repeat(32) } },
    )) as Buffer;
    const without = (await build.call({}, base)) as Buffer;
    expect(withRef.toString()).toContain(`X-Delivery-Ref: ${"c".repeat(32)}`);
    expect(without.toString()).not.toContain("X-Delivery-Ref");
  });
});

describe("the stored message id (C3)", () => {
  it("record() gets the provider id, which EmailDeliveryService stores in its bare form", async () => {
    const { svc, deliveries } = make({ platformSmtp: true });
    await svc.send({ ...mail, delivery: ctx });
    expect(row(deliveries).providerMessageId).toBe("<P@platform>");
  });
});

describe("C6: sendInvoice passes its own delivery context", () => {
  const base = {
    to: "buyer@example.com",
    customerName: "Acme Buyer",
    invoiceNumber: "INV-1",
    invoiceId: "inv-1",
    issueDate: "Jan 1, 2026",
    dueDate: "Jan 31, 2026",
    total: 100,
    items: [],
  } as any;

  it("an invoice email is INVOICE_SENT on entity Invoice/inv-1", async () => {
    const { svc } = make();
    const spy = jest.spyOn(svc, "send").mockResolvedValue({ delivered: true, transport: "smtp" });
    await svc.sendInvoice(base);
    expect(spy.mock.calls[0][0].delivery).toEqual({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      entityType: "Invoice",
      entityId: "inv-1",
    });
  });

  it("a reminder is INVOICE_REMINDER", async () => {
    const { svc } = make();
    const spy = jest.spyOn(svc, "send").mockResolvedValue({ delivered: true, transport: "smtp" });
    await svc.sendInvoice({ ...base, isReminder: true });
    expect(spy.mock.calls[0][0].delivery?.kind).toBe("INVOICE_REMINDER");
  });

  it("T8: a completion email naming two more invoices asks for one row per invoice", async () => {
    const { svc } = make();
    const spy = jest.spyOn(svc, "send").mockResolvedValue({ delivered: true, transport: "smtp" });
    await svc.sendInvoice({ ...base, alsoInvoiceIds: ["inv-2", "inv-3"] });
    expect(spy.mock.calls[0][0].delivery).toMatchObject({
      entityId: "inv-1",
      alsoEntityIds: ["inv-2", "inv-3"],
    });
  });
});
