import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
// Hermetic (B909): the mocked Resend client delivers, so a send that is NOT held is visible as delivered:true.
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ data: { id: "re_1" }, error: null }) },
  })),
}));

/**
 * W-1464 / SA-1538 PR-A: the mail wall. A TEST-class business may mail only the addresses on its allowed
 * list (PlatformConfig); every other class, and a caller with no business, sends as today. A TEST business
 * with no list is the dark step: send as today and log "would hold".
 */
const T = "t-acme-test";
const LISTED = "tester@acme.example";
const OTHER = "someone-else@acme.example";

function makeService(
  opts: {
    klass?: string;
    /** the stored PlatformConfig value; undefined = no row; "THROW" = the read fails */
    list?: string | "THROW";
    classThrows?: boolean;
    tenantId?: string | null;
    mailboxDelivers?: boolean;
  } = {},
) {
  const trySend = jest
    .fn()
    .mockResolvedValue(
      opts.mailboxDelivers
        ? { delivered: true, transport: "mailbox", id: "mb_1", fromAddress: "x@y.example" }
        : { delivered: false, transport: "mailbox", error: "not_connected" },
    );
  const tenantFind = jest.fn(async () => {
    if (opts.classThrows) throw new Error("db down");
    return { class: opts.klass ?? "TEST" };
  });
  const queryRaw = jest.fn(async () => {
    if (opts.list === "THROW") throw new Error("db down");
    return opts.list === undefined ? [] : [{ value: opts.list }];
  });
  const prisma = {
    getTenantId: () => (opts.tenantId === undefined ? T : opts.tenantId),
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    tenant: { findUnique: tenantFind },
    $queryRaw: queryRaw,
  } as any;
  const record = jest.fn();
  const svc = new EmailService(
    { get: (k: string) => (k === "RESEND_API_KEY" ? "re_test" : undefined) } as any,
    prisma,
    { decrypt: (v: string) => v } as any,
    { trySend } as any,
    { record } as any,
    {} as any,
  );
  const resendSend = (svc as any).resend.emails.send as jest.Mock;
  const warn = jest.spyOn((svc as any).logger, "warn");
  const log = jest.spyOn((svc as any).logger, "log");
  return { svc, trySend, resendSend, tenantFind, queryRaw, record, warn, log };
}

const LIST = JSON.stringify([LISTED]);
// W-1464: send() takes the business as an explicit required field (null = no business at all).
const mail = (to: string, tenantId: string | null = T) => ({
  to,
  subject: "x",
  html: "<p>x</p>",
  tenantId,
});
const platformMail = (to: string, tenantId: string | null = T) => ({ ...mail(to), tenantId });

describe("mail wall: a TEST business with a list (R1, R2)", () => {
  it("T1: send() to an address off the list is held and reaches no transport", async () => {
    const { svc, trySend, resendSend } = makeService({ list: LIST, mailboxDelivers: true });
    const res = await svc.send(mail(OTHER));
    expect(res.delivered).toBe(false);
    expect(res.holdCode).toBe("MAIL_WALL_HELD");
    expect(trySend).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("T1: send() to a listed address goes out as today (the wall is not a blanket block)", async () => {
    const { svc, trySend } = makeService({ list: LIST, mailboxDelivers: true });
    const res = await svc.send(mail(LISTED));
    expect(res.delivered).toBe(true);
    expect(trySend).toHaveBeenCalledTimes(1);
  });

  it("T1: matching is on the lower-cased address", async () => {
    const { svc } = makeService({ list: LIST, mailboxDelivers: true });
    expect((await svc.send(mail("Tester@Acme.Example"))).delivered).toBe(true);
  });

  it("T1: a plus entry `name+*@domain` allows plus-addressing of that name only", async () => {
    const list = JSON.stringify(["tester+*@acme.example"]);
    const a = makeService({ list, mailboxDelivers: true });
    expect((await a.svc.send(mail("tester+orders@acme.example"))).delivered).toBe(true);
    for (const to of ["tester@acme.example", "tester2+x@acme.example", "tester+x@other.example"]) {
      const b = makeService({ list, mailboxDelivers: true });
      expect((await b.svc.send(mail(to))).holdCode).toBe("MAIL_WALL_HELD");
    }
  });

  it("T2: a held recorded send writes ONE failed delivery row with a masked address and zero attempts", async () => {
    const { svc, record } = makeService({ list: LIST, mailboxDelivers: true });
    await svc.send({
      ...mail(OTHER),
      delivery: { tenantId: T, kind: "INVOICE_SENT", entityType: "Invoice", entityId: "inv1" },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      tenantId: T,
      status: "FAILED",
      attempts: 0,
      sentAt: null,
      toAddress: "***@acme.example",
    });
  });

  it("T2: the explicit business wins over the delivery context and the request's", async () => {
    const { svc, tenantFind } = makeService({
      list: LIST,
      tenantId: "t-other",
      mailboxDelivers: true,
    });
    await svc.send({
      ...mail(OTHER),
      delivery: {
        tenantId: "t-ctx",
        kind: "INVOICE_SENT",
        entityType: "Invoice",
        entityId: "inv1",
      },
    });
    expect(tenantFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: T } }));
    expect(tenantFind).toHaveBeenCalledTimes(1);
  });

  it("T7 (H1): the four paths that used to reach the wall with no business are held", async () => {
    // Each runs with NO request business (cron, super-admin, public auth routes), so only the
    // explicit field can name the business.
    const digest = makeService({ list: LIST, tenantId: null });
    const d = await digest.svc.sendLowStockDigest({
      tenantId: T,
      to: OTHER,
      businessName: "Acme",
      items: [{ name: "Widget", sku: "W-1", currentStock: 1, reorderPoint: 5 }],
    });
    expect(d.holdCode).toBe("MAIL_WALL_HELD");
    expect(digest.resendSend).not.toHaveBeenCalled();

    for (const kind of ["welcome", "resend verification", "password reset"]) {
      const { svc, resendSend } = makeService({ list: LIST, tenantId: null });
      const res = await svc.send({ ...mail(OTHER), senderClass: "platform" });
      expect([kind, res.holdCode]).toEqual([kind, "MAIL_WALL_HELD"]);
      expect(resendSend).not.toHaveBeenCalled();
    }
  });

  it("T7: an explicit null is never held, even when the request carries a Test business", async () => {
    const { svc, resendSend, tenantFind } = makeService({ list: LIST });
    const res = await svc.send(mail(OTHER, null));
    expect(res.delivered).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(tenantFind).not.toHaveBeenCalled();
  });

  it("T2: a platform-class send() is held once, at the send entry", async () => {
    const { svc, resendSend, tenantFind } = makeService({ list: LIST });
    const res = await svc.send({ ...mail(OTHER), senderClass: "platform" });
    expect(res.holdCode).toBe("MAIL_WALL_HELD");
    expect(resendSend).not.toHaveBeenCalled();
    expect(tenantFind).toHaveBeenCalledTimes(1);
  });

  it("T3: sendPlatform() for that business to an off-list address is held", async () => {
    const { svc, resendSend } = makeService({ list: LIST });
    const res = await svc.sendPlatform(platformMail(OTHER));
    expect(res.delivered).toBe(false);
    expect(res.holdCode).toBe("MAIL_WALL_HELD");
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("T3: sendPlatform() to a listed address sends", async () => {
    const { svc, resendSend } = makeService({ list: LIST });
    expect((await svc.sendPlatform(platformMail(LISTED))).delivered).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("T3: a wrapper (set-password invite) carries the business through to the wall", async () => {
    const { svc, resendSend } = makeService({ list: LIST });
    const res = await svc.sendSetPasswordEmail({
      to: OTHER,
      username: "u",
      setPasswordUrl: "https://app.example/reset?token=abc",
      expiryHours: 72,
      tenantId: T,
    });
    expect(res.delivered).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("T6: a list that cannot be read holds (fail closed), and so does a failed list read", async () => {
    for (const list of [
      "not json",
      JSON.stringify(["@gmail.com"]),
      JSON.stringify({ a: 1 }),
      "THROW" as const,
    ]) {
      const { svc, resendSend } = makeService({ list });
      const res = await svc.sendPlatform(platformMail(LISTED));
      expect(res.holdCode).toBe("MAIL_WALL_HELD");
      expect(resendSend).not.toHaveBeenCalled();
    }
  });
});

describe("mail wall: every other case sends as today (R3, R4)", () => {
  it.each(["PRODUCTION", "DEMO", "INTERNAL"])(
    "T4 (guard): class %s is never held, whatever a list says",
    async (klass) => {
      const { svc, trySend } = makeService({ klass, list: LIST, mailboxDelivers: true });
      const res = await svc.send(mail(OTHER));
      expect(res.delivered).toBe(true);
      expect(res.holdCode).toBeUndefined();
      expect(trySend).toHaveBeenCalledTimes(1);
    },
  );

  it("T4 (guard): a caller with no business (owner alert, demo booking) is never held and reads nothing", async () => {
    const { svc, resendSend, tenantFind, queryRaw } = makeService({ list: LIST, tenantId: null });
    expect((await svc.sendPlatform(platformMail(OTHER, null))).delivered).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(tenantFind).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("T5: a TEST business with no list sends as today and logs one `would hold` line (the dark step)", async () => {
    const { svc, trySend, warn } = makeService({ mailboxDelivers: true });
    const res = await svc.send(mail(OTHER));
    expect(res.delivered).toBe(true);
    expect(trySend).toHaveBeenCalledTimes(1);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("would hold"));
    expect(lines).toHaveLength(1);
    // the log carries the domain only, never the address (B911 rule)
    expect(lines[0]).not.toContain(OTHER);
    expect(lines[0]).toContain("acme.example");
  });

  it("T5: the dark step on sendPlatform logs too, and sends", async () => {
    const { svc, warn } = makeService();
    expect((await svc.sendPlatform(platformMail(OTHER))).delivered).toBe(true);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("would hold")),
    ).toHaveLength(1);
  });

  it("T6: a class that cannot be read sends as today and logs an error (a database outage, not a state)", async () => {
    const { svc, trySend } = makeService({ classThrows: true, list: LIST, mailboxDelivers: true });
    const error = jest.spyOn((svc as any).logger, "error");
    const res = await svc.send(mail(OTHER));
    expect(res.delivered).toBe(true);
    expect(trySend).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });
});
