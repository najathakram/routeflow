import { EmailService } from "./email.service";
import { EmailDeliveryService, sanitizeDeliveryError } from "./email-delivery.service";
import { EMAIL_KINDS, type EmailKind } from "./email-kinds";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";

describe("EMAIL_KINDS", () => {
  it("includes the WS4 kinds", () => {
    const kinds: readonly string[] = Array.isArray(EMAIL_KINDS)
      ? EMAIL_KINDS
      : Object.values(EMAIL_KINDS as unknown as Record<string, string>);
    for (const k of [
      "STAFF_NEW_ORDER",
      "BUYER_ORDER_EDITED",
      "BUYER_ORDER_CANCELLED",
      "LOW_STOCK_DIGEST",
      "INVOICE_SENT",
      "AUTH_OTHER",
    ]) {
      expect(kinds).toContain(k);
    }
  });
});

describe("sanitizeDeliveryError", () => {
  it("returns null for null/undefined/empty-ish", () => {
    expect(sanitizeDeliveryError(null)).toBeNull();
    expect(sanitizeDeliveryError(undefined)).toBeNull();
  });

  it("masks every email address via redactAddresses (local part masked, domain kept) and IP literals", () => {
    const out = sanitizeDeliveryError(
      "550 rejected jane@example.com and cc bob.x+1@sub.acme.io ok",
    );
    expect(out).toBe("550 rejected ***@example.com and cc ***@sub.acme.io ok");
    expect(sanitizeDeliveryError("connect EHOSTUNREACH 10.0.1.4:587")).toBe(
      "connect EHOSTUNREACH [address]:587",
    );
  });

  it("truncates to 500 chars", () => {
    const out = sanitizeDeliveryError("x".repeat(2000));
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(500);
  });

  it("redacts then stays within 500 chars", () => {
    const out = sanitizeDeliveryError(`${"a@b.co ".repeat(300)}`) as string;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).not.toMatch(/a@b\.co/);
  });

  it("leaves a plain message untouched", () => {
    expect(sanitizeDeliveryError("Set a From email in Settings")).toBe(
      "Set a From email in Settings",
    );
  });
});

describe("EmailDeliveryService.record (best-effort audit)", () => {
  function make(createImpl?: jest.Mock) {
    const create = createImpl ?? jest.fn().mockResolvedValue({});
    const models = { emailDelivery: { create } };
    const prisma = { ...models, forTenant: jest.fn().mockReturnValue(models) } as any;
    return { svc: new EmailDeliveryService(prisma), create };
  }

  it("writes one row carrying the given fields", async () => {
    const { svc, create } = make();
    const sentAt = new Date("2026-09-30T10:00:00Z");
    await svc.record({
      tenantId: "t1",
      kind: "STAFF_NEW_ORDER",
      toAddress: "a@example.com",
      entityType: "Order",
      entityId: "o1",
      status: "SENT",
      providerMessageId: "pm-1",
      attempts: 1,
      sentAt,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        tenantId: "t1",
        kind: "STAFF_NEW_ORDER",
        toAddress: "a@example.com",
        entityType: "Order",
        entityId: "o1",
        status: "SENT",
        providerMessageId: "pm-1",
        sentAt,
      }),
    );
  });

  it("never stores a subject or body", async () => {
    const { svc, create } = make();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      status: "SENT",
      ...({ subject: "secret", html: "<p>secret</p>", body: "secret" } as object),
    } as any);
    const data = create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("subject");
    expect(data).not.toHaveProperty("html");
    expect(data).not.toHaveProperty("body");
  });

  it("swallows a prisma failure (never throws)", async () => {
    const { svc } = make(jest.fn().mockRejectedValue(new Error("db down")));
    await expect(
      svc.record({
        tenantId: "t1",
        kind: "AUTH_OTHER",
        toAddress: "a@example.com",
        status: "FAILED",
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a synchronous throw too", async () => {
    const { svc } = make(
      jest.fn(() => {
        throw new Error("sync boom");
      }),
    );
    await expect(
      svc.record({
        tenantId: "t1",
        kind: "AUTH_OTHER",
        toAddress: "a@example.com",
        status: "FAILED",
      }),
    ).resolves.toBeUndefined();
  });

  it("sanitizes the error string it stores", async () => {
    const { svc, create } = make();
    await svc.record({
      tenantId: "t1",
      kind: "AUTH_OTHER",
      toAddress: "a@example.com",
      status: "FAILED",
      error: "rejected bob@example.com",
    });
    expect(create.mock.calls[0][0].data.error).toBe("rejected ***@example.com");
  });
});

/**
 * EmailService.send delivery rows. ASSUMPTION: the EmailDeliveryService is the 5th constructor
 * arg (config, prisma, encryption, mailboxSend, deliveries). The mailbox transport is used as the
 * deterministic transport (trySend delivered:true/false) so no network is touched.
 */
describe("EmailService.send — delivery ctx rows", () => {
  const ctx = {
    tenantId: "t1",
    kind: "STAFF_NEW_ORDER" as EmailKind,
    entityType: "Order",
    entityId: "o1",
  };

  function make(
    mailbox: jest.Mock,
    deliveries = { record: jest.fn().mockResolvedValue(undefined) },
  ) {
    const envMap: Record<string, string | undefined> = {};
    const config = { get: (k: string) => envMap[k] } as any;
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
    const encryption = { decrypt: (v: string) => v } as any;
    const svc = new (EmailService as any)(
      config,
      prisma,
      encryption,
      { trySend: mailbox },
      deliveries,
    ) as EmailService;
    return { svc, deliveries };
  }

  beforeEach(() => {
    (nodemailer.createTransport as jest.Mock).mockReset();
  });

  it("delivered:true => one SENT row with providerMessageId", async () => {
    const mailbox = jest
      .fn()
      .mockResolvedValue({ delivered: true, transport: "mailbox", id: "gmail-123" });
    const { svc, deliveries } = make(mailbox);
    const res = await svc.send({
      to: "a@example.com",
      subject: "s",
      html: "<p>x</p>",
      delivery: ctx,
    } as any);
    expect(res.delivered).toBe(true);
    expect(deliveries.record).toHaveBeenCalledTimes(1);
    expect(deliveries.record.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        tenantId: "t1",
        kind: "STAFF_NEW_ORDER",
        toAddress: "a@example.com",
        entityType: "Order",
        entityId: "o1",
        status: "SENT",
        providerMessageId: "gmail-123",
      }),
    );
  });

  it("delivered:false => one FAILED row with a sanitized error <= 500", async () => {
    const mailbox = jest.fn().mockResolvedValue({
      delivered: false,
      transport: "mailbox",
      error: "not_connected",
    });
    const { svc, deliveries } = make(mailbox);
    const res = await svc.send({
      to: "a@example.com",
      subject: "s",
      html: "<p>x</p>",
      delivery: ctx,
    } as any);
    expect(res.delivered).toBe(false);
    expect(deliveries.record).toHaveBeenCalledTimes(1);
    const row = deliveries.record.mock.calls[0][0];
    expect(row.status).toBe("FAILED");
    expect(typeof row.error).toBe("string");
    expect(row.error.length).toBeLessThanOrEqual(500);
    expect(row.error).not.toMatch(/a@example\.com/);
  });

  it("a thrown transport error => FAILED row, send still resolves (never rejects)", async () => {
    const mailbox = jest.fn().mockRejectedValue(new Error("boom for a@example.com"));
    const { svc, deliveries } = make(mailbox);
    const res = await svc.send({
      to: "a@example.com",
      subject: "s",
      html: "<p>x</p>",
      delivery: ctx,
    } as any);
    expect(res.delivered).toBe(false);
    expect(deliveries.record).toHaveBeenCalledTimes(1);
    const row = deliveries.record.mock.calls[0][0];
    expect(row.status).toBe("FAILED");
    expect(row.error).not.toMatch(/a@example\.com/);
  });

  it("no delivery ctx => no row", async () => {
    const mailbox = jest.fn().mockResolvedValue({ delivered: true, transport: "mailbox", id: "x" });
    const { svc, deliveries } = make(mailbox);
    await svc.send({ to: "a@example.com", subject: "s", html: "<p>x</p>" });
    expect(deliveries.record).not.toHaveBeenCalled();
  });

  it("row-write failure never changes the send result", async () => {
    const mailbox = jest.fn().mockResolvedValue({ delivered: true, transport: "mailbox", id: "x" });
    const { svc } = make(mailbox, { record: jest.fn().mockRejectedValue(new Error("audit down")) });
    const res = await svc.send({
      to: "a@example.com",
      subject: "s",
      html: "<p>x</p>",
      delivery: ctx,
    } as any);
    expect(res.delivered).toBe(true);
  });

  const SENTINEL_ERR = "Recipient is an internal placeholder address (no real email on file).";

  it.each([
    ["3f2a9c1e-uuid-1@placeholder.local", "placeholder.local"],
    ["no-email+1@IMPORTED.local", "IMPORTED.local"],
  ])(
    "sentinel recipient %s with a delivery ctx records ONE masked FAILED row, no transport",
    async (to, domain) => {
      const mailbox = jest.fn().mockResolvedValue({ delivered: true, transport: "mailbox" });
      const { svc, deliveries } = make(mailbox);
      const res = await svc.send({ to, subject: "s", html: "<p>x</p>", delivery: ctx } as any);
      expect(res).toEqual({ delivered: false, transport: "none", error: SENTINEL_ERR });
      expect(mailbox).not.toHaveBeenCalled();
      expect(deliveries.record).toHaveBeenCalledTimes(1);
      const row = deliveries.record.mock.calls[0][0];
      expect(row).toEqual(
        expect.objectContaining({
          tenantId: "t1",
          kind: "STAFF_NEW_ORDER",
          entityType: "Order",
          entityId: "o1",
          status: "FAILED",
          error: SENTINEL_ERR,
          attempts: 0,
          toAddress: `***@${domain}`,
        }),
      );
      expect(row.toAddress).not.toContain(to.split("@")[0]);
    },
  );

  it("sentinel refusal: a record failure never changes the result", async () => {
    const { svc } = make(jest.fn(), { record: jest.fn().mockRejectedValue(new Error("down")) });
    const res = await svc.send({
      to: "x@placeholder.local",
      subject: "s",
      html: "<p>x</p>",
      delivery: ctx,
    } as any);
    expect(res).toEqual({ delivered: false, transport: "none", error: SENTINEL_ERR });
  });

  it("sentinel recipient WITHOUT a delivery ctx writes no row", async () => {
    const { svc, deliveries } = make(jest.fn());
    const res = await svc.send({ to: "x@placeholder.local", subject: "s", html: "<p>x</p>" });
    expect(res.delivered).toBe(false);
    expect(deliveries.record).not.toHaveBeenCalled();
  });
});
