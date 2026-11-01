/**
 * W-1060 (SA-1070 R26, R27, R30, R31) on real Postgres, through the REAL OrdersService (status moves, 404s), the REAL
 * ReadyForPickupService and the REAL PickupCompleteService. Only the customer-message senders are spies:
 *  - R27: Ready, demote, Ready, then Complete at counter -> TWO emails: one Ready, one completion (master sent three).
 *  - R26: Ready, then Complete at counter -> one email each (the completion email is its own event and key).
 *  - Record: the audit row is `entityType "order"` / `order.ready_for_pickup` and tenant-scoped: GET reads it back with
 *    the address, and a failed resend after a SENT row never hides the SENT one (R31).
 *  - R30: GET on another tenant's order answers 404.
 *
 * The DB lane runs it (`npm run local:test:db`, test tenants only). Two throwaway `qa-w1060-<run>` tenants; `afterAll`
 * deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));
import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildDbOrdersService } from "../common/testing/orders-service-db-harness";
import { AuditService } from "../audit/audit.service";
import { MessagingService } from "../messaging/messaging.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PickupCompleteService } from "./counter-sale/pickup-complete.service";
import { ReadyForPickupService } from "./ready-for-pickup.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-1060 Ready for pickup record — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-w1060-${run}`, "ready-for-pickup.db.spec.ts");
  const slugB = assertTestTenant(`qa-w1060b-${run}`, "ready-for-pickup.db.spec.ts");
  const tenants: { id: string; userId: string; customerId: string; productId: string }[] = [];
  const orderIds: string[] = [];
  let n = 0;

  // Spies: the Ready email (messaging.notify), the push, the completion email, and the status-change events.
  const readyEmail = jest.fn(async (..._a: unknown[]): Promise<Array<Record<string, unknown>>> => [
    { channel: "EMAIL", outcome: "sent" },
  ]);
  const pushes = jest.fn(async (..._a: unknown[]) => undefined);
  const events = jest.fn(async (..._a: unknown[]) => undefined);
  const completionEmail = jest.fn(async (..._a: unknown[]) => ({ delivered: true }));
  const sentInvoices: string[] = [];

  const operator = (t: 0 | 1) =>
    ({
      sub: tenants[t].userId,
      email: `o${t}-${run}@example.test`,
      username: `o${t}-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenants[t].id,
      tenantSlug: t === 0 ? slugA : slugB,
    }) as JwtPayload;
  const as = <T>(t: 0 | 1, fn: () => Promise<T>) => tenantCtx.run(tenants[t].id, fn);

  const messaging = {
    notify: readyEmail,
    sendChannels: async () => ["EMAIL"] as never,
  };
  const ready = () =>
    new ReadyForPickupService(
      orders,
      prisma,
      { sendToCustomer: pushes } as never,
      messaging as never,
      new AuditService(prisma),
    );
  const complete = (orderId: string) =>
    as(0, () =>
      new (PickupCompleteService as any)(
        orders,
        orders.invoicesService,
        prisma,
        { get: async () => ({ methods: ["ROUTE", "SHIP", "PICKUP"], counter: "off" }) } as never,
        { emitRouteProgress: jest.fn() } as never,
      ).complete(orderId, {} as never, operator(0), `key-${run}-${n}`),
    );

  /** A CONFIRMED PICKUP order with one zero-priced line and its DRAFT invoice (nothing owed, so no tender). */
  async function seed(t: 0 | 1 = 0) {
    n += 1;
    const { id: tenantId, customerId, productId } = tenants[t];
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "CONFIRMED" as never,
        fulfillPath: "PICKUP" as never,
        orderNumber: `W1060-${run}-${t}-${n}`,
        subtotal: "0",
        total: "0",
      },
    });
    orderIds.push(order.id);
    await raw.orderItem.create({
      data: { orderId: order.id, productId, tenantId, qty: 2, unitPrice: 0, subtotal: 0 },
    });
    await raw.invoice.create({
      data: {
        invoiceNumber: `INV-W1060-${run}-${t}-${n}`,
        customerId,
        orderId: order.id,
        tenantId,
        status: "DRAFT",
        subtotal: 0,
        total: 0,
      },
    });
    return order.id;
  }
  const press = (orderId: string, body: { resend?: boolean } = {}) =>
    as(0, () => ready().markReady(orderId, operator(0), body));
  const demote = (orderId: string) =>
    as(0, () =>
      orders.changeStatus(
        orderId,
        { status: "CONFIRMED", reason: "W-1060 spec: back to Confirmed" },
        operator(0),
        { silent: true },
      ),
    );
  const rows = (orderId: string) =>
    raw.auditLog.findMany({
      where: { entityId: orderId, action: "order.ready_for_pickup" },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    orders = buildDbOrdersService(prisma, tenantCtx, {
      pushes,
      events,
      invoices: {
        send: async (id: string) => {
          sentInvoices.push(id);
          await raw.invoice.update({ where: { id }, data: { status: "SENT" } });
          return { status: "SENT" };
        },
        recordPayment: jest.fn(),
        sendCompletionEmail: completionEmail,
      },
    });
    for (const [t, slug] of [slugA, slugB].entries()) {
      const tenantId = (await raw.tenant.create({ data: { slug, name: `W1060 ${slug}` } })).id;
      const userId = (
        await raw.user.create({
          data: {
            email: `o${t}-${run}@example.test`,
            username: `o${t}-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      const customerId = (
        await raw.customer.create({
          data: {
            userId,
            businessName: `Acme Test ${t} ${run}`,
            contactName: "Tester",
            email: `buyer-${t}-${run}@acme.test`,
            tenantId,
          },
        })
      ).id;
      const productId = (
        await raw.product.create({
          data: {
            name: `Widget ${t} ${run}`,
            unit: "ea",
            pricePerUnit: "0.00",
            currentStock: "100",
            tenantId,
          },
        })
      ).id;
      tenants.push({ id: tenantId, userId, customerId, productId });
    }
  }, 90_000);

  afterAll(async () => {
    try {
      for (const t of tenants) {
        await raw.auditLog.deleteMany({ where: { tenantId: t.id } });
        await raw.notificationRule.deleteMany({ where: { tenantId: t.id } });
        await raw.messageTemplate.deleteMany({ where: { tenantId: t.id } });
        await raw.systemConfig.deleteMany({ where: { tenantId: t.id } });
        await raw.counterDayClose.deleteMany({ where: { tenantId: t.id } });
        await raw.invoice.deleteMany({ where: { tenantId: t.id } });
        await raw.orderItem.deleteMany({ where: { tenantId: t.id } });
        await raw.order.deleteMany({ where: { tenantId: t.id } });
        await raw.product.deleteMany({ where: { tenantId: t.id } });
        await raw.customer.deleteMany({ where: { tenantId: t.id } });
        await raw.user.deleteMany({ where: { tenantId: t.id } });
        await raw.tenant.delete({ where: { id: t.id } });
      }
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  });

  beforeEach(() => {
    readyEmail.mockClear();
    pushes.mockClear();
    events.mockClear();
    completionEmail.mockClear();
    sentInvoices.length = 0;
  });

  it("the Ready press writes one `order` / order.ready_for_pickup row with the address, and GET reads it back", async () => {
    const id = await seed();
    expect(await press(id)).toEqual({ notice: "SENT", email: `buyer-0-${run}@acme.test` });
    const written = await rows(id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      tenantId: tenants[0].id,
      entityType: "order",
      entityId: id,
      meta: { notice: "SENT", email: `buyer-0-${run}@acme.test` },
    });
    const rec = await as(0, () => ready().getRecord(id, operator(0)));
    expect(rec.preview).toEqual({ notice: "SENT", email: `buyer-0-${run}@acme.test` });
    expect(rec.last).toMatchObject({ notice: "SENT", email: `buyer-0-${run}@acme.test` });
  });

  it("R27: Ready, demote, Ready, then Complete at counter: two emails, one Ready and one completion", async () => {
    const id = await seed();
    await press(id);
    await demote(id);
    const second = await press(id);
    expect(second).toMatchObject({ toldOnce: true, email: `buyer-0-${run}@acme.test` });
    expect((await raw.order.findUniqueOrThrow({ where: { id } })).status).toBe("OUT_FOR_DELIVERY");
    expect(readyEmail).toHaveBeenCalledTimes(1);
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(await rows(id)).toHaveLength(1);

    await complete(id);
    await new Promise((r) => setImmediate(r));
    expect((await raw.order.findUniqueOrThrow({ where: { id } })).status).toBe("DELIVERED");
    expect(readyEmail).toHaveBeenCalledTimes(1); // still the one Ready email
    expect(completionEmail).toHaveBeenCalledTimes(1); // plus the completion email
  });

  it("R26: Ready, then Complete at counter: one email each", async () => {
    const id = await seed();
    await press(id);
    await complete(id);
    await new Promise((r) => setImmediate(r));
    expect(readyEmail).toHaveBeenCalledTimes(1);
    expect(completionEmail).toHaveBeenCalledTimes(1);
  });

  it("R31: a failed Send again after a SENT row: GET's last is still the SENT row", async () => {
    const id = await seed();
    await press(id);
    readyEmail.mockResolvedValueOnce([
      { channel: "EMAIL", outcome: "failed", reason: "SEND_FAILED" },
    ]);
    expect(await press(id, { resend: true })).toEqual({ notice: "FAILED" });
    const written = await rows(id);
    expect(written.map((r) => (r.meta as { notice: string }).notice)).toEqual(["SENT", "FAILED"]);
    expect((written[1].meta as { resend?: boolean }).resend).toBe(true);
    const rec = await as(0, () => ready().getRecord(id, operator(0)));
    expect(rec.last).toMatchObject({ notice: "SENT" });
  });

  it("R30: GET on another tenant's order answers 404", async () => {
    const id = await seed(0);
    await expect(as(1, () => ready().getRecord(id, operator(1)))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * SA-1070 A-1: the line answers from what the send would do. The REAL MessagingService (its rule and template reads, and
   * notify's seeding) runs; only `sendMessage` is a spy. Each row reads the preview, presses, and the two must agree.
   */
  describe("A-1: the preview and the press agree on the rule rows (R36-R42)", () => {
    const sent = jest.fn(async (input: { channel: string }) => ({
      channel: input.channel,
      outcome: "sent",
    }));
    let real: MessagingService;
    const readyReal = () =>
      new ReadyForPickupService(
        orders,
        prisma,
        { sendToCustomer: pushes } as never,
        real as never,
        new AuditService(prisma),
      );
    const rule = (channel: "EMAIL" | "PORTAL", enabled: boolean) =>
      raw.notificationRule.create({
        data: { tenantId: tenants[0].id, eventKey: "READY_FOR_PICKUP", channel, enabled },
      });
    const template = (channel: "EMAIL" | "PORTAL", isActive: boolean) =>
      raw.messageTemplate.create({
        data: {
          tenantId: tenants[0].id,
          eventKey: "READY_FOR_PICKUP",
          channel,
          body: "Order {{orderNumber}} is ready for pickup.",
          isActive,
        },
      });
    const ruleCount = () => raw.notificationRule.count({ where: { tenantId: tenants[0].id } });
    const emails = () => sent.mock.calls.filter(([i]) => i.channel === "EMAIL").length;
    /** Preview, then press: the two answers, with the number of emails the press sent. */
    async function previewThenPress() {
      const id = await seed();
      const { preview } = await as(0, () => readyReal().getRecord(id, operator(0)));
      const pressed = await as(0, () => readyReal().markReady(id, operator(0), {}));
      return { id, preview, pressed, sentEmails: emails() };
    }

    beforeAll(() => {
      real = new MessagingService(prisma, {} as never, {} as never);
      jest.spyOn(real, "sendMessage").mockImplementation(sent as never);
    });
    beforeEach(async () => {
      sent.mockClear();
      await raw.notificationRule.deleteMany({ where: { tenantId: tenants[0].id } });
      await raw.messageTemplate.deleteMany({ where: { tenantId: tenants[0].id } });
    });

    const email = () => `buyer-0-${run}@acme.test`;

    it("R36: no rule rows: a press seeds the defaults and sends, so the line says it sends", async () => {
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "SENT", email: email() });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(1);
    });

    it("R37: EMAIL and PORTAL both switched off: OFF, and nothing is sent", async () => {
      await rule("EMAIL", false);
      await rule("PORTAL", false);
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "OFF" });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(0);
    });

    it("R38: EMAIL on with its active copy: sends one email", async () => {
      await rule("EMAIL", true);
      await template("EMAIL", true);
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "SENT", email: email() });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(1);
    });

    it("R39: the EMAIL row missing beside PORTAL on: no seeding, so OFF (not 'no row means default')", async () => {
      await rule("PORTAL", true);
      await template("PORTAL", true);
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "OFF" });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(0);
    });

    it("R40: the EMAIL row missing beside PORTAL off: a press seeds EMAIL on and sends", async () => {
      await rule("PORTAL", false);
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "SENT", email: email() });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(1);
    });

    it("R41: EMAIL on but its copy inactive: OFF, nothing is sent", async () => {
      await rule("EMAIL", true);
      await template("EMAIL", false);
      const { preview, pressed, sentEmails } = await previewThenPress();
      expect(preview).toEqual({ notice: "OFF" });
      expect(pressed).toEqual(preview);
      expect(sentEmails).toBe(0);
    });

    it("R42: reading the line writes nothing: no rule rows after the GET, before the press", async () => {
      const id = await seed();
      expect(await ruleCount()).toBe(0);
      await as(0, () => readyReal().getRecord(id, operator(0)));
      expect(await ruleCount()).toBe(0);
      expect(await raw.messageTemplate.count({ where: { tenantId: tenants[0].id } })).toBe(0);
    });
  });
});
