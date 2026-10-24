import { ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { ReceiptService } from "./receipt.service";
import {
  RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT,
  RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY,
  RECEIPT_EMAIL_PER_ORDER_DEFAULT,
  RECEIPT_EMAIL_PER_ORDER_KEY,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY,
} from "./receipt-limits";
import { INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";
import { createMockPrisma, type MockPrisma } from "../testing/prisma-mock";
import {
  carriedReturnSelect,
  carriedReturnWhere,
  creditNoteReadSelect,
  creditNoteReadWhere,
  orderReturnSelect,
} from "../orders/counter-sale/counter-sale-today";

const T = "test-tenant";
const NOW = new Date("2026-10-07T16:00:00.000Z");

/** The order row as the service's select returns it: invoices carry their payments. */
function storedOrder(over: Record<string, unknown> = {}) {
  const { lineItems, ...rest } = orderFixture();
  return {
    ...rest,
    lineItems,
    invoices: [
      {
        ...INVOICE,
        payments: paymentsFixture().map(({ invoiceId: _ignored, ...p }) => p),
      },
    ],
    ...over,
  };
}

function setup(opts: {
  order?: unknown;
  sentOnOrder?: number;
  sentToday?: number;
  sentToAddress?: number;
  settings?: Record<string, string>;
  delivered?: boolean;
  timezone?: string | null;
}) {
  const prisma: MockPrisma = createMockPrisma();
  prisma.getTenantId.mockReturnValue(T);
  prisma.order.findFirst.mockResolvedValue(opts.order === undefined ? storedOrder() : opts.order);
  prisma.tenantConfig.findUnique.mockResolvedValue({
    businessName: "Acme Test Store",
    addressLine1: "1 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701",
    phone: "555-0100",
    timezone: opts.timezone === undefined ? "America/New_York" : opts.timezone,
  });
  prisma.systemConfig.findMany.mockResolvedValue(
    Object.entries(opts.settings ?? {}).map(([key, value]) => ({ key, value })),
  );
  // order count first, then the tenant's day count, then the address count (the service asks in that order)
  prisma.emailDelivery.count
    .mockResolvedValueOnce(opts.sentOnOrder ?? 0)
    .mockResolvedValueOnce(opts.sentToday ?? 0)
    .mockResolvedValueOnce(opts.sentToAddress ?? 0);
  const email = {
    send: jest
      .fn()
      .mockResolvedValue(
        opts.delivered === false
          ? { delivered: false, transport: "none", error: "no transport" }
          : { delivered: true, transport: "smtp", id: "m-1" },
      ),
  };
  const service = new ReceiptService(prisma as never, email as never);
  const send = (to = "buyer@example.com", id = "ord-1") =>
    service.send(id, { channel: "email", to }, NOW);
  return { prisma, email, service, send };
}

const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  return {
    status: (e as HttpException).getStatus(),
    code: (e as HttpException).getResponse() as { code?: string },
  };
};

describe("ReceiptService.send (POST /orders/:id/receipt)", () => {
  it("sends the rendered receipt to the typed address once, as a RECEIPT delivery on the Order, and answers { channel, to }", async () => {
    const { email, send } = setup({});
    await expect(send("Buyer@Example.com")).resolves.toEqual({
      channel: "email",
      to: "Buyer@Example.com",
    });
    expect(email.send).toHaveBeenCalledTimes(1);
    const arg = email.send.mock.calls[0][0];
    expect(arg.to).toBe("Buyer@Example.com");
    expect(arg.subject).toBe("Your receipt from Acme Test Store for order ORD-1001");
    expect(arg.html).toContain("$28.62");
    expect(arg.text).toContain("$28.62");
    expect(arg.delivery).toEqual({
      tenantId: T,
      kind: "RECEIPT",
      entityType: "Order",
      entityId: "ord-1",
    });
  });

  describe("tenant isolation", () => {
    it("reads the order scoped to the caller's tenant", async () => {
      const { prisma, send } = setup({});
      await send();
      const args = prisma.order.findFirst.mock.calls[0][0];
      expect(args.where).toEqual({ id: "ord-1", tenantId: T });
    });

    it("another tenant's order id is a 404, and nothing is sent or counted", async () => {
      const { prisma, email, send } = setup({ order: null });
      await expect(send("buyer@example.com", "other-tenants-order")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(email.send).not.toHaveBeenCalled();
      expect(prisma.emailDelivery.count).not.toHaveBeenCalled();
    });

    it("a request with no tenant context is refused before any read", async () => {
      const { prisma, email, service } = setup({});
      prisma.getTenantId.mockReturnValue(null);
      await expect(
        service.send("ord-1", { channel: "email", to: "a@b.co" }, NOW),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });

    it("counts only this tenant's RECEIPT rows (both counts carry tenantId and kind)", async () => {
      const { prisma, send } = setup({});
      await send();
      const [perOrder, perDay, perAddress] = prisma.emailDelivery.count.mock.calls.map(
        (c) => c[0].where,
      );
      expect(perOrder).toMatchObject({
        tenantId: T,
        kind: "RECEIPT",
        entityType: "Order",
        entityId: "ord-1",
        status: "SENT",
      });
      expect(perDay).toMatchObject({ tenantId: T, kind: "RECEIPT", status: "SENT" });
      expect(perDay.createdAt.gte).toBeInstanceOf(Date);
      expect(perAddress).toMatchObject({ tenantId: T, kind: "RECEIPT" });
    });
  });

  describe("per-order limit (default 3)", () => {
    it("the 3rd send still goes (2 already sent)", async () => {
      const { email, send } = setup({ sentOnOrder: 2 });
      await send();
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it("the 4th is a coded 429 RECEIPT_EMAIL_ORDER_LIMIT and nothing is sent", async () => {
      const { email, send } = setup({ sentOnOrder: RECEIPT_EMAIL_PER_ORDER_DEFAULT });
      const { status, code } = await codeOf(send());
      expect(status).toBe(429);
      expect(code.code).toBe("RECEIPT_EMAIL_ORDER_LIMIT");
      expect(email.send).not.toHaveBeenCalled();
    });

    it("reads the cap from the tenant's receipts.email.perOrder setting", async () => {
      const { email, send } = setup({
        sentOnOrder: 1,
        settings: { [RECEIPT_EMAIL_PER_ORDER_KEY]: "1" },
      });
      const { code } = await codeOf(send());
      expect(code.code).toBe("RECEIPT_EMAIL_ORDER_LIMIT");
      expect(email.send).not.toHaveBeenCalled();
    });

    it.each(["0", "-2", "abc", "2.5", "", "  "])(
      "an unusable setting value (%j) falls back to the default",
      async (raw) => {
        const { email, send } = setup({
          sentOnOrder: 2,
          settings: { [RECEIPT_EMAIL_PER_ORDER_KEY]: raw },
        });
        await send();
        expect(email.send).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("per-day tenant limit (default 100)", () => {
    it("the 100th send of the day still goes (99 already sent)", async () => {
      const { email, send } = setup({ sentToday: RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT - 1 });
      await send();
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it("the 101st is a coded 429 RECEIPT_EMAIL_DAY_LIMIT and nothing is sent", async () => {
      const { email, send } = setup({ sentToday: RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT });
      const { status, code } = await codeOf(send());
      expect(status).toBe(429);
      expect(code.code).toBe("RECEIPT_EMAIL_DAY_LIMIT");
      expect(email.send).not.toHaveBeenCalled();
    });

    it("reads the cap from receipts.email.perTenantPerDay", async () => {
      const { send } = setup({
        sentToday: 5,
        settings: { [RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY]: "5" },
      });
      expect((await codeOf(send())).code.code).toBe("RECEIPT_EMAIL_DAY_LIMIT");
    });

    it("the day starts at midnight in the TENANT's zone, not the server's", async () => {
      const { prisma, send } = setup({ timezone: "America/New_York" });
      await send();
      const perDay = prisma.emailDelivery.count.mock.calls[1][0].where;
      // 2026-10-07 16:00Z is 12:00 in New York (EDT): that day began at 04:00Z
      expect((perDay.createdAt.gte as Date).toISOString()).toBe("2026-10-07T04:00:00.000Z");
    });

    it("the per-order limit is checked first (its message is the one the cashier can act on)", async () => {
      const { send } = setup({
        sentOnOrder: RECEIPT_EMAIL_PER_ORDER_DEFAULT,
        sentToday: RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
      });
      expect((await codeOf(send())).code.code).toBe("RECEIPT_EMAIL_ORDER_LIMIT");
    });
  });

  describe("what the receipt is built from (SA-762r money model)", () => {
    it("reads the stored tax rate lines, the cash handed over and the order's tax, scoped through the tenant order read", async () => {
      const { prisma, send } = setup({});
      await send();
      const select = prisma.order.findFirst.mock.calls[0][0].select;
      expect(select.tax).toBe(true);
      expect(select.counterCashTendered).toBe(true);
      // the STORED line rate only: a rate is never inferred from the invoice header
      // CQ-03: the rate AND the billed levy with its category name
      expect(select.invoices.select.items.select).toEqual({
        taxRate: true,
        categoryTaxAmount: true,
        trackedCategoryId: true,
        categoryTaxType: true,
        trackedCategory: { select: { id: true, name: true, taxType: true } },
      });
      expect(select.invoices.select).not.toHaveProperty("subtotal");
      expect(select.invoices.select).not.toHaveProperty("taxAmount");
    });

    it("reads the payments in the order they were taken (the first stored tender decides whether change is served)", async () => {
      const { prisma, send } = setup({});
      await send();
      const sel = prisma.order.findFirst.mock.calls[0][0].select.invoices.select;
      expect(sel.payments.orderBy).toEqual({ createdAt: "asc" });
    });

    it("a stored line rate that is not the tenant's configured rate is plain Tax (the rate is never inferred)", async () => {
      const { email, send } = setup({ settings: { "settings.taxRate": "8.25" } });
      await send();
      const { html, text } = email.send.mock.calls[0][0];
      for (const body of [html, text]) {
        expect(body).not.toContain("Tax (");
        expect(body).toContain("$2.12");
      }
    });

    it("emails the split money rows: Tax (8%) from the stored line rate the configured rate corroborates, no Adjustments when nothing remains", async () => {
      const { email, send } = setup({ settings: { "settings.taxRate": "8" } });
      await send();
      const { html, text } = email.send.mock.calls[0][0];
      for (const body of [html, text]) {
        expect(body).toContain("Tax (8%)");
        expect(body).toContain("$2.12");
        expect(body).not.toContain("Adjustments");
      }
    });

    it("prints the business's receipt footer (settings.receiptFooter), HTML-escaped", async () => {
      const { email, send } = setup({
        settings: { "settings.receiptFooter": "Thanks <b>&</b> come again" },
      });
      await send();
      const { html, text } = email.send.mock.calls[0][0];
      expect(html).toContain("Thanks &lt;b&gt;&amp;&lt;/b&gt; come again");
      expect(html).not.toContain("<b>&</b>");
      expect(text).toContain("Thanks <b>&</b> come again");
    });

    it("shows the struck list price and a Discounts row for a lowered line (the invoices' rule), unless the tenant hides original prices (invoice.hideOriginalPrice)", async () => {
      const shown = setup({});
      await shown.send();
      expect(shown.email.send.mock.calls[0][0].text).toContain("Discount");
      const hidden = setup({ settings: { "invoice.hideOriginalPrice": "true" } });
      await hidden.send();
      const { html, text } = hidden.email.send.mock.calls[0][0];
      for (const body of [html, text]) expect(body).not.toContain("Discount");
      const read = hidden.prisma.systemConfig.findMany.mock.calls[0][0].where.key.in;
      expect(read).toContain("invoice.hideOriginalPrice");
    });

    it("prints the cash handed over when the sale stored it", async () => {
      const { email, send } = setup({ order: storedOrder({ counterCashTendered: "50.00" }) });
      await send();
      expect(email.send.mock.calls[0][0].text).toContain("Tendered: $50.00");
      expect(email.send.mock.calls[0][0].text).toContain("Change: $30.00");
    });
  });

  describe("per-address daily cap (default 5)", () => {
    it("the 5th receipt to one address in the day goes (4 already)", async () => {
      const { email, send } = setup({
        sentToAddress: RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT - 1,
      });
      await send();
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it("the 6th is a coded 429 RECEIPT_EMAIL_ADDRESS_LIMIT and nothing is sent", async () => {
      const { email, send } = setup({ sentToAddress: RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT });
      const { status, code } = await codeOf(send());
      expect(status).toBe(429);
      expect(code.code).toBe("RECEIPT_EMAIL_ADDRESS_LIMIT");
      expect(email.send).not.toHaveBeenCalled();
    });

    it("a different address still goes when one address is at its cap (the count is per address)", async () => {
      const { prisma, email, send } = setup({});
      const counts: Record<string, number> = { "full@example.com": 5 };
      prisma.emailDelivery.count.mockReset();
      prisma.emailDelivery.count.mockImplementation(async (args: any) =>
        args.where.toAddress ? (counts[args.where.toAddress.equals] ?? 0) : 0,
      );
      expect((await codeOf(send("full@example.com"))).code.code).toBe(
        "RECEIPT_EMAIL_ADDRESS_LIMIT",
      );
      expect(email.send).not.toHaveBeenCalled();
      await send("other@example.com");
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it("counts ALL statuses (a failed or queued attempt used the address too), this tenant's RECEIPT rows, from the tenant's day start", async () => {
      const { prisma, send } = setup({});
      await send("buyer@example.com");
      const where = prisma.emailDelivery.count.mock.calls[2][0].where;
      expect(where).not.toHaveProperty("status");
      expect(where).toMatchObject({ tenantId: T, kind: "RECEIPT" });
      expect((where.createdAt.gte as Date).toISOString()).toBe("2026-10-07T04:00:00.000Z");
    });

    it("the count key is the NORMALISED address (trim + lowercase, case-insensitive), the address sent and logged is the one typed (trimmed)", async () => {
      const { prisma, email, service } = setup({});
      await service.send("ord-1", { channel: "email", to: "  A.Buyer@Example.COM " }, NOW);
      const where = prisma.emailDelivery.count.mock.calls[2][0].where;
      expect(where.toAddress).toEqual({ equals: "a.buyer@example.com", mode: "insensitive" });
      expect(email.send.mock.calls[0][0].to).toBe("A.Buyer@Example.COM");
    });

    it("reads the cap from receipts.email.perAddressPerDay, and an unusable value falls back to the default", async () => {
      const a = setup({
        sentToAddress: 2,
        settings: { [RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY]: "2" },
      });
      expect((await codeOf(a.send())).code.code).toBe("RECEIPT_EMAIL_ADDRESS_LIMIT");
      for (const raw of ["0", "-1", "abc", "2.5", ""]) {
        const b = setup({
          sentToAddress: 4,
          settings: { [RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY]: raw },
        });
        await b.send();
        expect(b.email.send).toHaveBeenCalledTimes(1);
      }
    });

    it("is checked after the per-order and per-day limits", async () => {
      const { send } = setup({
        sentToday: RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
        sentToAddress: RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT,
      });
      expect((await codeOf(send())).code.code).toBe("RECEIPT_EMAIL_DAY_LIMIT");
    });
  });

  describe("which orders have a receipt", () => {
    it("a cancelled order is a 409 RECEIPT_NOT_AVAILABLE", async () => {
      const { email, send } = setup({ order: storedOrder({ status: "CANCELLED" }) });
      const { status, code } = await codeOf(send());
      expect(status).toBe(409);
      expect(code.code).toBe("RECEIPT_NOT_AVAILABLE");
      expect(email.send).not.toHaveBeenCalled();
    });

    it.each(["VOID", "WRITTEN_OFF"])(
      "an order whose only invoice is %s is a 409 RECEIPT_NOT_AVAILABLE",
      async (status) => {
        const base = storedOrder();
        const { email, send } = setup({
          order: { ...base, invoices: [{ ...base.invoices[0], status }] },
        });
        expect((await codeOf(send())).code.code).toBe("RECEIPT_NOT_AVAILABLE");
        expect(email.send).not.toHaveBeenCalled();
      },
    );

    it("an order with no invoice at all is a 409 RECEIPT_NOT_AVAILABLE", async () => {
      const { send } = setup({ order: storedOrder({ invoices: [] }) });
      expect((await codeOf(send())).code.code).toBe("RECEIPT_NOT_AVAILABLE");
    });

    it("a delivered (non-counter) order with a live invoice works too", async () => {
      const { email, send } = setup({ order: storedOrder({ counterSale: false }) });
      await send();
      expect(email.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("a send that does not leave", () => {
    it("is a coded 502 RECEIPT_EMAIL_NOT_SENT (never a 200), and the cashier may try again", async () => {
      const { send } = setup({ delivered: false });
      const { status, code } = await codeOf(send());
      expect(status).toBe(502);
      expect(code.code).toBe("RECEIPT_EMAIL_NOT_SENT");
    });

    it("the error body never carries the provider's text", async () => {
      const { send } = setup({ delivered: false });
      const { code } = await codeOf(send());
      expect(JSON.stringify(code)).not.toContain("no transport");
    });
  });

  describe("privacy: the typed address is never written anywhere but the delivery log", () => {
    it("writes no customer, order or invoice row", async () => {
      const { prisma, send } = setup({
        order: storedOrder({ customer: { businessName: "Walk-in customer", isWalkIn: true } }),
      });
      await send("someone@example.com");
      for (const model of [
        "customer",
        "order",
        "invoice",
        "invoicePayment",
        "systemConfig",
      ] as const) {
        for (const m of ["create", "update", "updateMany", "upsert", "delete"] as const) {
          expect((prisma[model] as Record<string, jest.Mock>)[m]).not.toHaveBeenCalled();
        }
      }
    });

    it("selects no customer email column at all (a pre-fill is the client's, never read here)", async () => {
      const { prisma, send } = setup({});
      await send();
      const select = prisma.order.findFirst.mock.calls[0][0].select;
      expect(select.customer.select).not.toHaveProperty("email");
    });
  });

  describe("B1262 N1 (SA-838a): a counter sale's returns are read once, with the Today's-sales read shapes", () => {
    const ownReturn = {
      id: "r-1",
      returnNumber: "RET-1",
      status: "REFUNDED",
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      creditNoteId: "cn-1",
      refundAmount: null,
      creditSubtotal: "2.50",
      creditTax: "0.00",
      creditCategoryTax: "0.00",
      kind: "STANDARD",
      items: [],
    };
    /** an INLINE return filed on order C, whose items were sold on this order (ord-1) */
    const inlineOnC = {
      id: "r-inline",
      creditNoteId: "cn-5",
      orderId: "ord-c",
      kind: "INLINE",
      status: "REFUNDED",
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      items: [{ sourceOrderId: "ord-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
    };
    /** $12.50 sale: $5.00 cash, plus (optionally) a $2.50 credit-note application. NO returns key: the order select has none. */
    const sale = (over: { applied?: boolean; counterSale?: boolean; cash?: string } = {}) => {
      const { lineItems, ...rest } = orderFixture({
        total: "12.50",
        tax: "0.00",
        counterSale: over.counterSale ?? true,
      });
      const payments: Array<Record<string, unknown>> = [
        { method: "CASH", amount: over.cash ?? "5.00", status: "PAID" },
      ];
      if (over.applied) {
        payments.push({
          method: "CREDIT_NOTE",
          amount: "2.50",
          status: "PAID",
          creditNoteId: "cn-1",
        });
      }
      return { ...rest, lineItems, invoices: [{ ...INVOICE, payments }] };
    };
    const note = (
      id: string,
      status: string,
      applications: Array<[number, string]> = [],
      invoiceId = "inv-1",
    ) => ({
      id,
      status,
      amount: "5.50",
      invoiceId,
      invoicePayments: applications.map(([amount, inv]) => ({
        amount: String(amount),
        invoiceId: inv,
      })),
    });
    /** the fake database: own-return reads match `orderId`; the carried read matches its OR (note id, or an item sold here) */
    const reads = (
      prisma: MockPrisma,
      data: { own?: unknown[]; carried?: Array<Record<string, any>>; notes?: unknown[] },
    ) => {
      prisma.return.findMany.mockImplementation((async (args: any) => {
        if (args.where.OR) {
          const ids: string[] = args.where.OR[0].creditNoteId.in;
          const orders: string[] = args.where.OR[1].items.some.sourceOrderId.in;
          return (data.carried ?? []).filter(
            (r) =>
              ids.includes(r.creditNoteId) ||
              (r.items ?? []).some((i: any) => orders.includes(i.sourceOrderId)),
          );
        }
        return data.own ?? [];
      }) as never);
      prisma.creditNote.findMany.mockResolvedValue((data.notes ?? []) as never);
    };
    const textOf = (email: { send: jest.Mock }) => email.send.mock.calls[0][0].text as string;
    const ownReads = (prisma: MockPrisma) =>
      (prisma.return.findMany.mock.calls as any[]).filter((c) => !c[0].where.OR);
    const carriedReads = (prisma: MockPrisma) =>
      (prisma.return.findMany.mock.calls as any[]).filter((c) => c[0].where.OR);

    it("the main order read has NO returns relation and no credit-note relation under the payments (one query for ANY order)", async () => {
      const { prisma, send } = setup({ order: sale() });
      await send();
      const select = prisma.order.findFirst.mock.calls[0][0].select;
      expect(select).not.toHaveProperty("returns");
      expect(select.invoices.select.payments.select).toEqual({
        method: true,
        amount: true,
        status: true,
        creditNoteId: true,
      });
    });

    it("a counter sale with an applied note: its own returns by the shared select, ONE carried read, ONE credit-note read, tenant-scoped", async () => {
      const { prisma, email, send } = setup({ order: sale({ applied: true }) });
      reads(prisma, {
        own: [ownReturn],
        notes: [note("cn-1", "APPLIED", [[2.5, "inv-1"]])],
      });
      await send();
      expect(ownReads(prisma)).toEqual([
        [{ where: { tenantId: T, orderId: "ord-1" }, select: orderReturnSelect }],
      ]);
      expect(carriedReads(prisma)).toEqual([
        [{ where: carriedReturnWhere(T, ["cn-1"], ["ord-1"]), select: carriedReturnSelect }],
      ]);
      expect(prisma.creditNote.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.creditNote.findMany).toHaveBeenCalledWith({
        where: creditNoteReadWhere(T, ["cn-1"]),
        select: creditNoteReadSelect,
      });
      expect(textOf(email)).toContain(
        "Payment method: Cash $5.00\nPaid: $5.00\nReturned: −$2.50\nBalance due: $5.00",
      );
    });

    it("the payment's invoice link comes from the credit-note read: a note issued against ANOTHER invoice stays a tender", async () => {
      const { prisma, email, send } = setup({ order: sale({ applied: true }) });
      reads(prisma, {
        own: [ownReturn],
        notes: [note("cn-1", "APPLIED", [[2.5, "inv-1"]], "inv-other")],
      });
      await send();
      expect(textOf(email)).toContain(
        "Payment method: Cash $5.00 + Store credit $2.50\nPaid: $7.50",
      );
      expect(textOf(email)).not.toContain("Returned");
    });

    it("an own return whose credit note was never applied: the carried read still runs (by order id), Credit kept prints", async () => {
      const { prisma, email, send } = setup({ order: sale() });
      reads(prisma, { own: [ownReturn], notes: [note("cn-1", "ISSUED")] });
      await send();
      expect(carriedReads(prisma)).toEqual([
        [{ where: carriedReturnWhere(T, [], ["ord-1"]), select: carriedReturnSelect }],
      ]);
      expect(prisma.creditNote.findMany).toHaveBeenCalledTimes(1);
      expect(textOf(email)).toContain("Credit kept $2.50 (returned items)");
      expect(textOf(email)).toContain("Balance due: $7.50");
    });

    it("an own INLINE return filed on another order whose credit was spent on a third: Credit used prints (found by sourceOrderId)", async () => {
      const { prisma, email, send } = setup({ order: sale({ cash: "12.50" }) });
      reads(prisma, {
        carried: [inlineOnC],
        notes: [note("cn-5", "APPLIED", [[5.5, "inv-b"]], "inv-c")],
      });
      await send();
      expect(prisma.creditNote.findMany).toHaveBeenCalledWith({
        where: creditNoteReadWhere(T, ["cn-5"]),
        select: creditNoteReadSelect,
      });
      expect(textOf(email)).toContain("Paid: $12.50\nCredit used $5.50 (returned items)");
      expect(textOf(email)).not.toContain("Balance due");
    });

    it("a counter sale with no credit note anywhere: the two return reads, NO credit-note read", async () => {
      const { prisma, send } = setup({ order: sale() });
      reads(prisma, {});
      await send();
      expect(ownReads(prisma)).toHaveLength(1);
      expect(carriedReads(prisma)).toHaveLength(1);
      expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
    });

    it("a delivery order with an applied note: NO return read, NO credit-note read, master's receipt", async () => {
      const { prisma, email, send } = setup({ order: sale({ applied: true, counterSale: false }) });
      await send();
      expect(prisma.return.findMany).not.toHaveBeenCalled();
      expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
      // #3576 Opus MUST: master's LITERAL line, labels only
      expect(textOf(email)).toContain(
        "Payment method: Cash + Store credit\nPaid: $7.50\nBalance due: $5.00",
      );
      expect(textOf(email)).not.toContain("Returned");
    });
  });
});
