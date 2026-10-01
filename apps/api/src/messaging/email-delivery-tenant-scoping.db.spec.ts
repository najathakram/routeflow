/**
 * #2872 review B1 — NEED-DB (authored here, run by the prover lane via `npm run local:test:db`).
 * Two throwaway `qa-*` tenants on real Postgres prove:
 *   1. tenant A's EmailDelivery rows never show up in tenant B's MessagingDeliveriesService
 *      list() / health();
 *   2. StaffOrderEmailService.notifyStaffEvent for tenant A's order never reads tenant B's admins
 *      or `notifications.staffCc`, and with NO ambient tenant (the unscoped client) it is refused:
 *      no rows, no send.
 * Follows the harness style of import/import-commercial-columns.db.spec.ts (real PrismaService +
 * TenantContextService, `assertTestTenant`, FK-safe cleanup in afterAll).
 */
import { randomUUID } from "crypto";
import { ForbiddenException } from "@nestjs/common";
import { NotificationEvent } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import { MessagingDeliveriesService } from "./messaging-deliveries.service";
import { StaffOrderEmailService } from "./staff-order-email";
import { StaffEmailSettingsService } from "./staff-email-settings.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("EmailDelivery tenant scoping (real Postgres)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let deliveries: EmailDeliveryService;
  let list: MessagingDeliveriesService;
  let staff: StaffOrderEmailService;
  let settings: StaffEmailSettingsService;
  let send: jest.Mock;
  const tenants: Record<"A" | "B", string> = { A: "", B: "" };
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    for (const side of ["A", "B"] as const) {
      const slug = assertTestTenant(
        `qa-2872-${side.toLowerCase()}-${RUN}`,
        "email-delivery-tenant-scoping.db.spec.ts",
      );
      const t = await prisma.tenant.create({ data: { slug, name: slug } });
      tenants[side] = t.id;
      const admin = await prisma.user.create({
        data: {
          tenantId: t.id,
          email: `admin-${side.toLowerCase()}-${RUN}@example.test`,
          username: `admin-${side.toLowerCase()}-${RUN}`,
          role: "TENANT_ADMIN",
        },
      });
      userIds.push(admin.id);
      const buyer = await prisma.user.create({
        data: {
          tenantId: t.id,
          email: `buyer-${side.toLowerCase()}-${RUN}@example.test`,
          username: `buyer-${side.toLowerCase()}-${RUN}`,
          role: "CUSTOMER",
        },
      });
      userIds.push(buyer.id);
      const customer = await prisma.customer.create({
        data: { tenantId: t.id, userId: buyer.id, businessName: `Acme ${side}`, contactName: "C" },
      } as never);
      customerIds.push(customer.id);
      const order = await prisma.order.create({
        data: { tenantId: t.id, customerId: customer.id, total: 10 },
      } as never);
      orderIds.push(order.id);
      await prisma.systemConfig.create({
        data: {
          tenantId: t.id,
          key: "notifications.staffCc",
          value: JSON.stringify([`cc-${side.toLowerCase()}-${RUN}@example.test`]),
        },
      } as never);
    }
    deliveries = new EmailDeliveryService(prisma);
    list = new MessagingDeliveriesService(prisma);
    send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" });
    staff = new StaffOrderEmailService(prisma, { send } as never, deliveries);
    settings = new StaffEmailSettingsService(prisma, staff);
    process.env.STAFF_ORDER_EMAIL = "dark";
  });

  afterAll(async () => {
    delete process.env.STAFF_ORDER_EMAIL;
    for (const id of Object.values(tenants)) {
      if (!id) continue;
      await prisma.emailDelivery.deleteMany({ where: { tenantId: id } }).catch(() => {});
      await prisma.systemConfig.deleteMany({ where: { tenantId: id } }).catch(() => {});
    }
    if (orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    }
    if (customerIds.length) {
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => {});
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    for (const id of Object.values(tenants)) {
      if (id) await prisma.tenant.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("tenant A's rows never appear in tenant B's list() / health()", async () => {
    await deliveries.record({
      tenantId: tenants.A,
      kind: "INVOICE_SENT",
      toAddress: `only-a-${RUN}@example.test`,
      status: "FAILED",
      error: "SMTP auth failed",
    });
    const listB = await ctx.run(tenants.B, () => list.list("TENANT_ADMIN", {}));
    expect(listB.items.some((i) => i.toAddress.includes(`only-a-${RUN}`))).toBe(false);
    const healthB = await ctx.run(tenants.B, () => list.health());
    expect(healthB.counts.FAILED).toBe(0);
    const listA = await ctx.run(tenants.A, () => list.list("TENANT_ADMIN", {}));
    expect(listA.items.some((i) => i.toAddress.includes(`only-a-${RUN}`))).toBe(true);
  });

  it("notify for A's order (ambient A) writes rows only for A's admin and A's staffCc", async () => {
    await ctx.run(tenants.A, () =>
      staff.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: orderIds[0] }),
    );
    const rows = await prisma.emailDelivery.findMany({
      where: { kind: "STAFF_NEW_ORDER", entityId: orderIds[0] },
    });
    const tos = rows.map((r) => r.toAddress).sort();
    expect(tos).toEqual([`admin-a-${RUN}@example.test`, `cc-a-${RUN}@example.test`]);
    for (const r of rows) expect(r.tenantId).toBe(tenants.A);
    expect(send).not.toHaveBeenCalled();
  });

  it("no ambient tenant (unscoped client) is refused: no rows, no send", async () => {
    const before = await prisma.emailDelivery.count();
    await staff.notifyStaffEvent(NotificationEvent.BUYER_ORDER_EDITED, { orderId: orderIds[0] });
    expect(await prisma.emailDelivery.count()).toBe(before);
    expect(send).not.toHaveBeenCalled();
  });

  it("ambient tenant B for A's order is refused", async () => {
    await ctx.run(tenants.B, () =>
      staff.notifyStaffEvent(NotificationEvent.BUYER_ORDER_CANCELLED, { orderId: orderIds[0] }),
    );
    const rows = await prisma.emailDelivery.findMany({
      where: { kind: "BUYER_ORDER_CANCELLED", entityId: orderIds[0] },
    });
    expect(rows).toHaveLength(0);
  });

  describe("no tenant context: requireTenantContext 403 (real services, real Prisma)", () => {
    const readCc = async (tenantId: string) =>
      (
        await prisma.systemConfig.findFirst({
          where: { tenantId, key: "notifications.staffCc" },
        })
      )?.value;

    it.each([
      ["MessagingDeliveriesService.list", () => list.list("TENANT_ADMIN", {})],
      ["MessagingDeliveriesService.health", () => list.health()],
      ["StaffEmailSettingsService.get", () => settings.get("TENANT_ADMIN")],
      [
        "StaffEmailSettingsService.update",
        () => settings.update({ staffCc: [`hijack-${RUN}@example.test`] }),
      ],
    ])(
      "%s rejects TENANT_CONTEXT_REQUIRED and leaves other tenants' staffCc untouched",
      async (_l, call) => {
        // Another tenant's rows exist (beforeAll) and the test runs OUTSIDE ctx.run: the unscoped
        // client would see/overwrite them if the guard were a no-op.
        const beforeA = await readCc(tenants.A);
        const beforeB = await readCc(tenants.B);
        expect(beforeA).toBeDefined();
        expect(beforeB).toBeDefined();
        const err: any = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
        expect(await readCc(tenants.A)).toBe(beforeA);
        expect(await readCc(tenants.B)).toBe(beforeB);
        expect(beforeA).toContain(`cc-a-${RUN}@example.test`);
        expect(beforeB).toContain(`cc-b-${RUN}@example.test`);
      },
    );
  });
});
