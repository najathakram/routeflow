import { ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { ReceiptService } from "./receipt.service";
import {
  RECEIPT_EMAIL_PER_ORDER_DEFAULT,
  RECEIPT_EMAIL_PER_ORDER_KEY,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY,
} from "./receipt-limits";
import { orderFixture, paymentsFixture } from "./receipt.fixtures";
import { createMockPrisma, type MockPrisma } from "../testing/prisma-mock";

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
        id: "inv-1",
        invoiceNumber: "INV-2001",
        status: "PAID",
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
  // order count first, then the day count (the service asks in that order)
  prisma.emailDelivery.count
    .mockResolvedValueOnce(opts.sentOnOrder ?? 0)
    .mockResolvedValueOnce(opts.sentToday ?? 0);
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
    expect(arg.subject).toBe("Your receipt from Acme Test Store (Order ORD-1001)");
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
      const [perOrder, perDay] = prisma.emailDelivery.count.mock.calls.map((c) => c[0].where);
      expect(perOrder).toMatchObject({
        tenantId: T,
        kind: "RECEIPT",
        entityType: "Order",
        entityId: "ord-1",
        status: "SENT",
      });
      expect(perDay).toMatchObject({ tenantId: T, kind: "RECEIPT", status: "SENT" });
      expect(perDay.createdAt.gte).toBeInstanceOf(Date);
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
});
