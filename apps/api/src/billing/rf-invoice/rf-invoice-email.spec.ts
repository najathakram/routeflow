// PR3 MAIL-1: RouteFlow's own invoice email - the template (exact subjects, escaping, reply-to, pay
// instructions) and BillingNotificationService.sendRfInvoice (every admin, claim-keyed auto sends,
// never throws). No database: a fake Prisma that enforces the (tenant, milestone, key) unique claim.
import { BillingNotificationService } from "../billing-notification.service";
import { rfInvoiceEmail } from "../billing-notification.templates";

const INV = {
  number: "RF-2026-0007",
  amount: 149,
  currency: "USD",
  periodStart: new Date("2026-10-13T00:00:00.000Z"),
  periodEnd: new Date("2026-11-12T00:00:00.000Z"),
  dueDate: new Date("2026-10-13T00:00:00.000Z"),
  lines: [
    {
      kind: "PLAN",
      code: "STARTER",
      label: "Starter plan",
      quantity: 1,
      unitAmount: 149,
      amount: 149,
    },
  ],
};

describe("MAIL-1 rfInvoiceEmail", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("issued: the exact subject, in USD with the UTC due date", () => {
    expect(rfInvoiceEmail("issue", INV, "Acme Retail").subject).toBe(
      "RouteFlow invoice RF-2026-0007: $149.00 due Oct 13",
    );
  });

  it("reminders: the exact overdue subjects, singular and plural, and the due-today one", () => {
    expect(rfInvoiceEmail("d7", INV, "Acme Retail").subject).toBe(
      "Reminder: RouteFlow invoice RF-2026-0007 is 7 days overdue",
    );
    expect(rfInvoiceEmail("d14", INV, "Acme Retail").subject).toBe(
      "Reminder: RouteFlow invoice RF-2026-0007 is 14 days overdue",
    );
    expect(rfInvoiceEmail("d0", INV, "Acme Retail").subject).toBe(
      "Reminder: RouteFlow invoice RF-2026-0007 is due today",
    );
  });

  it("manual resend: the issued subject until the due date passes, then the overdue one", () => {
    expect(rfInvoiceEmail("manual", { ...INV, overdueDays: 0 }, "Acme").subject).toBe(
      "RouteFlow invoice RF-2026-0007: $149.00 due Oct 13",
    );
    expect(rfInvoiceEmail("manual", { ...INV, overdueDays: 1 }, "Acme").subject).toBe(
      "Reminder: RouteFlow invoice RF-2026-0007 is 1 day overdue",
    );
    expect(rfInvoiceEmail("manual", { ...INV, overdueDays: 3 }, "Acme").subject).toBe(
      "Reminder: RouteFlow invoice RF-2026-0007 is 3 days overdue",
    );
  });

  it("escapes the tenant name and every line label in the html", () => {
    const evil = 'Acme <script>alert("x")</script> & Co';
    const t = rfInvoiceEmail(
      "issue",
      { ...INV, lines: [{ ...INV.lines[0], label: "<img src=x onerror=1>" }] },
      evil,
    );
    expect(t.html).not.toContain("<script>");
    expect(t.html).not.toContain("<img");
    expect(t.html).toContain("&lt;script&gt;");
    expect(t.html).toContain("&lt;img");
    expect(t.html).toContain("&amp; Co");
  });

  it("body: period, the line table (label, qty, amount), the stored total, the due date and the reference line", () => {
    const t = rfInvoiceEmail(
      "issue",
      {
        ...INV,
        amount: 188.99,
        lines: [
          {
            kind: "PLAN",
            code: "STARTER",
            label: "Starter plan",
            quantity: 1,
            unitAmount: 149,
            amount: 149,
          },
          {
            kind: "ADDON",
            code: "SMS",
            label: "SMS pack",
            quantity: 2,
            unitAmount: 19.995,
            amount: 39.99,
          },
        ],
      },
      "Acme Retail",
    );
    for (const s of [
      "Oct 13, 2026",
      "Nov 12, 2026",
      "Starter plan",
      "SMS pack",
      "$149.00",
      "$39.99",
    ]) {
      expect(t.html).toContain(s);
      expect(t.text).toContain(s);
    }
    // the total is the STORED amount, never a re-sum of the lines
    expect(t.html).toContain("$188.99");
    expect(t.text).toContain("$188.99");
    expect(t.text).toContain(
      "Pay the way you usually do and include RF-2026-0007 as the reference. Questions? Reply to this email.",
    );
    expect(t.html).toContain("Acme Retail");
  });

  it("a malformed lines value never throws", () => {
    expect(() => rfInvoiceEmail("issue", { ...INV, lines: null as never }, "Acme")).not.toThrow();
    expect(() =>
      rfInvoiceEmail("issue", { ...INV, lines: [null, 5] as never }, "Acme"),
    ).not.toThrow();
  });

  it("replyTo is PLATFORM_BILLING_REPLY_TO when set, absent otherwise", () => {
    delete process.env.PLATFORM_BILLING_REPLY_TO;
    expect(rfInvoiceEmail("issue", INV, "Acme").replyTo).toBeUndefined();
    process.env.PLATFORM_BILLING_REPLY_TO = "billing@routeflow.test";
    expect(rfInvoiceEmail("issue", INV, "Acme").replyTo).toBe("billing@routeflow.test");
  });

  it("RF_INVOICE_PAY_INSTRUCTIONS: absent by default, included (escaped) when set", () => {
    delete process.env.RF_INVOICE_PAY_INSTRUCTIONS;
    expect(rfInvoiceEmail("issue", INV, "Acme").text).not.toContain("Zelle");
    process.env.RF_INVOICE_PAY_INSTRUCTIONS = "Zelle to pay@acme.test <b>only</b>";
    const t = rfInvoiceEmail("issue", INV, "Acme");
    expect(t.text).toContain("Zelle to pay@acme.test <b>only</b>");
    expect(t.html).toContain("Zelle to pay@acme.test &lt;b&gt;only&lt;/b&gt;");
    expect(t.html).not.toContain("<b>only");
  });
});

// ─── sendRfInvoice ────────────────────────────────────────────────────────────

function make(
  opts: {
    admins?: { email: string; username: string | null }[];
    deliver?: (to: string) => boolean | Error;
  } = {},
) {
  const seen = new Set<string>();
  const create = jest.fn(async ({ data }: any) => {
    const k = `${data.tenantId}/${data.milestone}/${data.key}`;
    if (seen.has(k)) throw Object.assign(new Error("dup"), { code: "P2002" });
    seen.add(k);
    return {};
  });
  const del = jest.fn(async ({ where }: any) => {
    const k = where.tenantId_milestone_key;
    seen.delete(`${k.tenantId}/${k.milestone}/${k.key}`);
    return {};
  });
  const prisma: any = {
    billingNotificationLog: { create, delete: del },
    user: {
      findMany: jest.fn(async () =>
        opts.admins === undefined
          ? [
              { email: "jamie@acme.test", username: "Jamie" },
              { email: "sam@acme.test", username: null },
            ]
          : opts.admins,
      ),
    },
    tenant: { findUnique: jest.fn(async () => ({ name: "Acme Retail", slug: "acme" })) },
    tenantConfig: { findFirst: jest.fn(async () => null) },
  };
  const sendPlatform = jest.fn(async ({ to }: any) => {
    const r = opts.deliver?.(to) ?? true;
    if (r instanceof Error) throw r;
    return { delivered: r, transport: "smtp" };
  });
  const svc = new BillingNotificationService(prisma, { sendPlatform } as any);
  return { svc, prisma, create, del, sendPlatform };
}

const INVOICE = { ...INV, id: "inv-1", tenantId: "tenant-acme" };

describe("MAIL-1 BillingNotificationService.sendRfInvoice", () => {
  beforeEach(() => {
    process.env.PLATFORM_BILLING_REPLY_TO = "billing@routeflow.test";
  });
  afterEach(() => {
    delete process.env.PLATFORM_BILLING_REPLY_TO;
  });

  it("emails EVERY active tenant admin with the exact subject and the reply-to", async () => {
    const { svc, sendPlatform } = make();
    const r = await svc.sendRfInvoice(INVOICE, "issue");
    expect(r).toEqual({ status: "sent", recipients: 2 });
    expect(sendPlatform).toHaveBeenCalledTimes(2);
    expect(sendPlatform.mock.calls.map((c: any) => c[0].to).sort()).toEqual([
      "jamie@acme.test",
      "sam@acme.test",
    ]);
    expect(sendPlatform.mock.calls[0][0]).toMatchObject({
      subject: "RouteFlow invoice RF-2026-0007: $149.00 due Oct 13",
      replyTo: "billing@routeflow.test",
    });
    expect(sendPlatform.mock.calls[0][0].html).toContain("Acme Retail");
  });

  it("an auto kind is claim-keyed '<number>:issued' / '<number>:d7' under milestone rf-invoice: a rerun sends nothing", async () => {
    const { svc, create, sendPlatform } = make();
    await svc.sendRfInvoice(INVOICE, "issue");
    expect(create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-acme", milestone: "rf-invoice", key: "RF-2026-0007:issued" },
    });
    sendPlatform.mockClear();
    const again = await svc.sendRfInvoice(INVOICE, "issue");
    expect(again.status).toBe("skipped");
    expect(sendPlatform).not.toHaveBeenCalled();

    await svc.sendRfInvoice(INVOICE, "d7");
    expect(create).toHaveBeenLastCalledWith({
      data: { tenantId: "tenant-acme", milestone: "rf-invoice", key: "RF-2026-0007:d7" },
    });
  });

  it("manual is NOT claim-keyed: it can be sent again (the caller's cooldown is the guard)", async () => {
    const { svc, create, sendPlatform } = make();
    expect((await svc.sendRfInvoice(INVOICE, "manual")).status).toBe("sent");
    expect((await svc.sendRfInvoice(INVOICE, "manual")).status).toBe("sent");
    expect(create).not.toHaveBeenCalled();
    expect(sendPlatform).toHaveBeenCalledTimes(4);
  });

  it("no admins: no_recipients, and an auto claim is released so a later admin still gets it", async () => {
    const { svc, del, sendPlatform } = make({ admins: [] });
    expect(await svc.sendRfInvoice(INVOICE, "d7")).toEqual({
      status: "no_recipients",
      recipients: 0,
    });
    expect(await svc.sendRfInvoice(INVOICE, "manual")).toEqual({
      status: "no_recipients",
      recipients: 0,
    });
    expect(sendPlatform).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("nothing delivered: failed, and the auto claim is released for the next tick", async () => {
    const { svc, del } = make({ deliver: () => false });
    expect(await svc.sendRfInvoice(INVOICE, "d7")).toEqual({ status: "failed", recipients: 0 });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("one admin delivered, one not: sent with the delivered COUNT", async () => {
    const { svc } = make({ deliver: (to) => to.startsWith("jamie") });
    expect(await svc.sendRfInvoice(INVOICE, "manual")).toEqual({ status: "sent", recipients: 1 });
  });

  it("never throws: a transport that throws, or a broken lookup, is a failed result", async () => {
    const boom = make({ deliver: () => new Error("smtp down") });
    await expect(boom.svc.sendRfInvoice(INVOICE, "manual")).resolves.toMatchObject({
      status: "failed",
    });
    const broken = make();
    broken.prisma.user.findMany.mockRejectedValue(new Error("db down"));
    await expect(broken.svc.sendRfInvoice(INVOICE, "manual")).resolves.toMatchObject({
      status: "failed",
    });
  });
});
