/**
 * SA-1026 Part A on the pickup HAND-OVER, on real Postgres: a named customer's order is handed over with `payment: {
 * method: "ON_ACCOUNT", expectedMethod: "CHECK" }` ("the check is not in hand yet"):
 *   A-G1: zero InvoicePayment rows; every invoice still open after the send step carries expectedPaymentMethod CHECK; the
 *         response reads `toCollect: TO_COLLECT` back from storage.
 *   A-G2: a walk-in sending it is 400 WALK_IN_NO_ACCOUNT before any write (the order is not handed over).
 *   A-G4: a same-key replay that omits the field writes nothing new and the first intent stays.
 *   a settled sibling invoice is never marked (nothing to collect); a plain ON_ACCOUNT hand-over stays unmarked.
 *   D-G2 / D-G3 (the duplicate check number is never a dead end): after a DUPLICATE_PAYMENT_REF refusal the same key resends
 *         either a fresh number (one CHECK payment, no second hand-over) or "Check not received yet" (0 payments, marked,
 *         the dedupe never consulted again).
 * Collaborators other than Prisma / the advisory lock are stand-ins, as in pickup-complete-register.db.spec.ts:
 * `changeStatus` and `send` write the rows the real ones would. NOT RUN by the authoring lane against anything but the
 * fresh `rf_dbspec_*` database `npm run local:test:db` creates. Slug `qa-i1026-*` is approved by assertTestTenant.
 */
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../order-status-invoicing", () => ({ settleOrderInvoice: jest.fn() }));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { PickupCompleteService } from "./pickup-complete.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1026 To collect on the pickup hand-over, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: PickupCompleteService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-i1026-handover-${run}`,
    "pickup-complete.to-collect.db.spec.ts",
  );
  let tenantId = "";
  let operator!: JwtPayload;
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;
  /** What the stand-in `recordPayment` does; each test sets it. The default refuses (an On account hand-over never records). */
  let recordPaymentImpl: (
    invoiceId: string,
    dto: Record<string, unknown>,
  ) => Promise<unknown> = async () => {
    throw new Error("an On account hand-over must not record a payment");
  };
  const recordPaymentCalls: { invoiceId: string; dto: Record<string, unknown> }[] = [];
  let changeStatusCalls = 0;
  const duplicateRefusal = () =>
    new ConflictException({
      code: "DUPLICATE_PAYMENT_REF",
      existingPayment: {
        id: "pay-1",
        paymentNumber: "PAY-A-0001",
        paidAt: new Date("2026-10-01T12:00:00.000Z").toISOString(),
        amount: 20,
        invoiceId: "inv-9",
        invoiceNumber: "INV-0042",
      },
    });

  /** An OUT_FOR_DELIVERY PICKUP order with one DRAFT invoice of 20.00 (+ optionally a settled sibling of 5.00). */
  async function pickupOrder(opts: { walkIn?: boolean; paidSibling?: boolean } = {}) {
    seq += 1;
    const user = await raw.user.create({
      data: {
        email: `c-${seq}-${run}@example.test`,
        username: `c-${seq}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(user.id);
    const customer = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme Test ${seq}`,
        contactName: "Tester",
        tenantId,
        isWalkIn: opts.walkIn === true,
      },
    });
    customerIds.push(customer.id);
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        tenantId,
        counterSale: false,
        fulfillPath: "PICKUP",
        status: "OUT_FOR_DELIVERY",
        orderNumber: `T${run}-${seq}`,
        total: opts.paidSibling ? 25 : 20,
      },
    });
    orderIds.push(order.id);
    const mkInvoice = async (n: number, status: "DRAFT" | "PAID", total: number) => {
      const inv = await raw.invoice.create({
        data: {
          invoiceNumber: `TINV-${run}-${seq}-${n}`,
          customerId: customer.id,
          orderId: order.id,
          tenantId,
          status,
          subtotal: total,
          total,
        },
      });
      invoiceIds.push(inv.id);
      if (status === "PAID") {
        await raw.invoicePayment.create({
          data: {
            invoiceId: inv.id,
            tenantId,
            amount: total,
            method: "CASH",
            status: "PAID",
            paidAt: new Date(),
          },
        });
      }
      return inv.id;
    };
    const first = await mkInvoice(1, "DRAFT", 20);
    const sibling = opts.paidSibling ? await mkInvoice(2, "PAID", 5) : null;
    return { orderId: order.id, invoiceId: first, siblingId: sibling };
  }

  const handOver = (
    orderId: string,
    payment: Record<string, unknown> | undefined,
    key = `key-${orderId}`,
  ) =>
    tenantCtx.run(tenantId, () => service.complete(orderId, { payment } as never, operator, key));

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 10 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `To collect ${slug}` } })).id;
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    userIds.push(op.id);
    operator = { sub: op.id, username: op.username, role: "OPERATOR", tenantId } as never;

    service = new PickupCompleteService(
      {
        changeStatus: async (id: string) => {
          changeStatusCalls += 1;
          return raw.order.update({
            where: { id },
            data: { status: "DELIVERED", deliveredAt: new Date() },
          });
        },
      } as never,
      {
        send: async (id: string) => raw.invoice.update({ where: { id }, data: { status: "SENT" } }),
        recordPayment: async (invoiceId: string, dto: Record<string, unknown>) => {
          recordPaymentCalls.push({ invoiceId, dto });
          return recordPaymentImpl(invoiceId, dto);
        },
      } as never,
      prisma,
      { get: async () => ({ methods: ["ROUTE", "SHIP", "PICKUP"], counter: "off" }) } as never,
    );
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenantConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const intentOf = async (invoiceId: string) =>
    (await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).expectedPaymentMethod;

  it("A-G1: ON_ACCOUNT + expectedMethod CHECK writes no payment, marks the open invoice CHECK, and reads To collect", async () => {
    const o = await pickupOrder();
    const res = await handOver(o.orderId, { method: "ON_ACCOUNT", expectedMethod: "CHECK" });
    expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(0);
    const inv = await raw.invoice.findUniqueOrThrow({ where: { id: o.invoiceId } });
    expect(inv.status).toBe("SENT");
    expect(inv.expectedPaymentMethod).toBe("CHECK");
    expect(res).toMatchObject({ paymentRecorded: true, paid: 0, balanceDue: 20 });
    expect((res as { toCollect?: string }).toCollect).toBe("TO_COLLECT");
  });

  it("a settled sibling invoice of the order is never marked; the open one is", async () => {
    const o = await pickupOrder({ paidSibling: true });
    await handOver(o.orderId, { method: "ON_ACCOUNT", expectedMethod: "CHECK" });
    expect(await intentOf(o.invoiceId)).toBe("CHECK");
    expect(await intentOf(o.siblingId as string)).toBeNull();
  });

  it("a plain ON_ACCOUNT hand-over stays unmarked and reads NONE (today's behaviour)", async () => {
    const o = await pickupOrder();
    const res = await handOver(o.orderId, { method: "ON_ACCOUNT" });
    expect(await intentOf(o.invoiceId)).toBeNull();
    expect((res as { toCollect?: string }).toCollect).toBe("NONE");
  });

  it("A-G4: a same-key replay that omits the field writes nothing new and the first intent stays", async () => {
    const o = await pickupOrder();
    await handOver(o.orderId, { method: "ON_ACCOUNT", expectedMethod: "CHECK" });
    const again = await handOver(o.orderId, { method: "ON_ACCOUNT" });
    expect(again).toMatchObject({ alreadyPickedUp: true });
    expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(0);
    expect(await intentOf(o.invoiceId)).toBe("CHECK");
    expect((again as { toCollect?: string }).toCollect).toBe("TO_COLLECT");
  });

  it("A-G2: a walk-in sending it is WALK_IN_NO_ACCOUNT before any write", async () => {
    const o = await pickupOrder({ walkIn: true });
    const err: any = await handOver(o.orderId, {
      method: "ON_ACCOUNT",
      expectedMethod: "CHECK",
    }).catch((e) => e);
    expect(err.getStatus?.()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: "WALK_IN_NO_ACCOUNT" });
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(
      "OUT_FOR_DELIVERY",
    );
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: o.invoiceId } })).status).toBe(
      "DRAFT",
    );
    expect(await intentOf(o.invoiceId)).toBeNull();
  });

  describe("a duplicate check number is never a dead end (D-G2, D-G3)", () => {
    const recordsAsCheck = async (invoiceId: string, dto: Record<string, unknown>) => {
      await raw.invoicePayment.create({
        data: {
          invoiceId,
          tenantId,
          amount: dto.amount as number,
          method: "CHECK",
          reference: dto.reference as string,
          status: "PAID",
          paidAt: new Date(),
        },
      });
      await raw.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
    };
    const refuseFirst = async (orderId: string, key: string) => {
      recordPaymentCalls.length = 0;
      changeStatusCalls = 0;
      recordPaymentImpl = async () => {
        throw duplicateRefusal();
      };
      const first = await handOver(orderId, { method: "CHECK", reference: "1042" }, key);
      expect(first).toMatchObject({
        paymentRecorded: false,
        paymentCauseCode: "DUPLICATE_PAYMENT_REF",
      });
      expect(changeStatusCalls).toBe(1);
      return first;
    };

    it("D-G2: Change check number with a fresh number on the handed-over order: one CHECK payment, no second hand-over", async () => {
      const o = await pickupOrder();
      const key = `key-dup-${o.orderId}`;
      await refuseFirst(o.orderId, key);
      recordPaymentImpl = recordsAsCheck;
      const again = await handOver(o.orderId, { method: "CHECK", reference: "1043" }, key);
      expect(again).toMatchObject({ paymentRecorded: true, alreadyPickedUp: true });
      const rows = await raw.invoicePayment.findMany({ where: { invoiceId: o.invoiceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ method: "CHECK", reference: "1043" });
      expect(changeStatusCalls).toBe(1);
    });

    it("D-G3: Check not received yet after the refusal: 0 payments, marked To collect, the dedupe never consulted", async () => {
      const o = await pickupOrder();
      const key = `key-dup-${o.orderId}`;
      await refuseFirst(o.orderId, key);
      const callsAfterRefusal = recordPaymentCalls.length;
      const again = await handOver(
        o.orderId,
        { method: "ON_ACCOUNT", expectedMethod: "CHECK" },
        key,
      );
      expect(again).toMatchObject({ paymentRecorded: true, alreadyPickedUp: true });
      expect((again as { toCollect?: string }).toCollect).toBe("TO_COLLECT");
      expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(0);
      expect(await intentOf(o.invoiceId)).toBe("CHECK");
      expect(recordPaymentCalls.length).toBe(callsAfterRefusal);
      expect(changeStatusCalls).toBe(1);
    });
  });
});
