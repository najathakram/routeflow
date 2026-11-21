import { readFileSync } from "fs";
import { join } from "path";
import { EmailDeliveryService } from "./email-delivery.service";
import { EmailDeliveryPruneService } from "./email-delivery-prune.service";
import { EMAIL_KINDS, EMAIL_KIND_AUDIENCE } from "./email-kinds";

/**
 * W-1286 PR-1 (SA-1202 C3, C5, C6, C7, C8, C10, C29): what a delivery row records, how many rows one email writes, and
 * how long a bounce-notice row lives.
 */
function makeWriter() {
  const create = jest.fn().mockResolvedValue({});
  const models = { emailDelivery: { create } };
  const prisma = { ...models, forTenant: jest.fn().mockReturnValue(models) } as any;
  return { svc: new EmailDeliveryService(prisma), create };
}

describe("EmailDeliveryService.record: route, token, fallback class", () => {
  it("stores route, refToken and fallbackReason when given, null when not", async () => {
    const { svc, create } = makeWriter();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      status: "SENT",
      route: "platform-smtp",
      refToken: "a".repeat(32),
      fallbackReason: "AUTH",
    });
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      status: "SENT",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      route: "platform-smtp",
      refToken: "a".repeat(32),
      fallbackReason: "AUTH",
    });
    expect(create.mock.calls[1][0].data).toMatchObject({
      route: null,
      refToken: null,
      fallbackReason: null,
    });
  });

  it("T10: the provider message id is stored in its bare form (no brackets, lower case)", async () => {
    const { svc, create } = makeWriter();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      status: "SENT",
      providerMessageId: "<AbC123@Mail.Example.com>",
    });
    expect(create.mock.calls[0][0].data.providerMessageId).toBe("abc123@mail.example.com");
  });
});

describe("C6 / T8: one completion email naming three invoices writes three rows", () => {
  it("one row per invoice, all with the same message id and status, the token on the first only", async () => {
    const { svc, create } = makeWriter();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      entityType: "Invoice",
      entityId: "inv-1",
      alsoEntityIds: ["inv-2", "inv-3"],
      status: "SENT",
      providerMessageId: "<m1@x.test>",
      route: "platform-smtp",
      refToken: "b".repeat(32),
    });
    expect(create).toHaveBeenCalledTimes(3);
    const data = create.mock.calls.map((c: any[]) => c[0].data);
    expect(data.map((d: any) => d.entityId)).toEqual(["inv-1", "inv-2", "inv-3"]);
    for (const d of data) {
      expect(d).toMatchObject({
        entityType: "Invoice",
        status: "SENT",
        providerMessageId: "m1@x.test",
        route: "platform-smtp",
      });
    }
    // refToken is unique per row: only the first carries it (the message id finds the siblings).
    expect(data.map((d: any) => d.refToken)).toEqual(["b".repeat(32), null, null]);
  });

  it("a single-invoice send still writes exactly one row", async () => {
    const { svc, create } = makeWriter();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      entityType: "Invoice",
      entityId: "inv-1",
      status: "SENT",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a duplicate id in the list is written once", async () => {
    const { svc, create } = makeWriter();
    await svc.record({
      tenantId: "t1",
      kind: "INVOICE_SENT",
      toAddress: "a@example.com",
      entityType: "Invoice",
      entityId: "inv-1",
      alsoEntityIds: ["inv-1", "inv-2", "inv-2"],
      status: "SENT",
    });
    expect(create.mock.calls.map((c: any[]) => c[0].data.entityId)).toEqual(["inv-1", "inv-2"]);
  });
});

describe("C6 / C7: the new kinds", () => {
  it("INVOICE_REMINDER and ORDER_STATUS are app-level kinds the tenant sees", () => {
    for (const k of ["INVOICE_REMINDER", "ORDER_STATUS"]) {
      expect(EMAIL_KINDS).toContain(k);
      expect((EMAIL_KIND_AUDIENCE as Record<string, string>)[k]).toBe("tenant");
    }
  });
});

describe("C10 / T9: retention", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date("2026-11-20T03:00:00Z");

  function make() {
    const emailDelivery = {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const emailBounceNotice = {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const prisma = {
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: "t1" }]) },
      emailDelivery,
      emailBounceNotice,
    } as any;
    return { svc: new EmailDeliveryPruneService(prisma), emailDelivery, emailBounceNotice };
  }

  it("T9: a notice row is pruned at 90 days: 89 days kept, 91 days pruned", async () => {
    const { svc, emailBounceNotice } = make();
    emailBounceNotice.findMany.mockResolvedValueOnce([{ id: "n1" }]).mockResolvedValue([]);
    emailBounceNotice.deleteMany.mockResolvedValue({ count: 1 });
    const out = await svc.prune(NOW);
    expect(out.deleted).toBe(1);
    const where = emailBounceNotice.findMany.mock.calls[0][0].where;
    const cutoff: Date = where.processedAt.lt;
    expect(new Date(NOW.getTime() - 89 * DAY) < cutoff).toBe(false);
    expect(new Date(NOW.getTime() - 91 * DAY) < cutoff).toBe(true);
    expect(emailBounceNotice.deleteMany.mock.calls[0][0].where.id.in).toEqual(["n1"]);
  });

  it("T9: an invoice delivery row is not pruned at 100 days (cutoff stays 730 days)", async () => {
    const { svc, emailDelivery } = make();
    await svc.prune(NOW);
    const invoiceWhere = emailDelivery.findMany.mock.calls
      .map((c: any[]) => c[0].where)
      .find((w: any) => w.entityType === "Invoice");
    const cutoff: Date = invoiceWhere.createdAt.lt;
    expect(new Date(NOW.getTime() - 100 * DAY) < cutoff).toBe(false);
  });
});

describe("T25: the ratcheted services gain zero lines of this work", () => {
  const root = join(__dirname, "..");
  it("invoices.service.ts and orders.service.ts carry no delivery record, kind or header", () => {
    for (const f of ["invoices/invoices.service.ts", "orders/orders.service.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      const hit = src.match(
        /emailDelivery|EMAIL_KINDS|INVOICE_REMINDER|"ORDER_STATUS"|X-Delivery-Ref|refToken|alsoInvoiceIds/,
      );
      expect(hit?.[0] ?? null).toBeNull();
    }
  });
});
