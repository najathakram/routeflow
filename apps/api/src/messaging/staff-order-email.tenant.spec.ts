import { Test } from "@nestjs/testing";
import { NotificationEvent } from "@prisma/client";
import { StaffOrderEmailService } from "./staff-order-email";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";

/**
 * #2872 review B1 — cross-tenant leak. `forTenant()` returns the UNSCOPED client when there is no
 * tenant context (job worker, SUPER_ADMIN, lost CLS). The fake below reproduces that: its
 * `forTenant()` returns every row, and each finder honours ONLY an explicit `where.tenantId`.
 */
type Row = Record<string, any>;

const USERS: Row[] = [
  {
    id: "a1",
    tenantId: "A",
    email: "admin@a.test",
    role: "TENANT_ADMIN",
    status: "ACTIVE",
    deletedAt: null,
  },
  {
    id: "b1",
    tenantId: "B",
    email: "admin@b.test",
    role: "TENANT_ADMIN",
    status: "ACTIVE",
    deletedAt: null,
  },
];
const CONFIGS: Row[] = [
  { tenantId: "A", key: "notifications.staffCc", value: JSON.stringify(["cc@a.test"]) },
  { tenantId: "B", key: "notifications.staffCc", value: JSON.stringify(["cc@b.test"]) },
];
const PREFS: Row[] = [];
const ORDERS: Row[] = [
  { id: "ordA", tenantId: "A", orderNumber: "1", total: 10, customer: { name: "x" } },
  { id: "ordB", tenantId: "B", orderNumber: "2", total: 20, customer: { name: "y" } },
];

function honours(rows: Row[], where: Row = {}): Row[] {
  return rows.filter((r) => {
    if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false;
    if (where.id !== undefined && typeof where.id === "string" && r.id !== where.id) return false;
    if (where.key !== undefined && r.key !== where.key) return false;
    if (where.role !== undefined && r.role !== where.role) return false;
    return true;
  });
}

function makeFake(ambient: string | null) {
  const user = { findMany: jest.fn(async (a: Row) => honours(USERS, a?.where)) };
  const userPreference = { findMany: jest.fn(async (a: Row) => honours(PREFS, a?.where)) };
  const systemConfig = {
    findFirst: jest.fn(async (a: Row) => honours(CONFIGS, a?.where)[0] ?? null),
    findMany: jest.fn(async (a: Row) => honours(CONFIGS, a?.where)),
  };
  const order = {
    findFirst: jest.fn(async (a: Row) => honours(ORDERS, a?.where)[0] ?? null),
    findUnique: jest.fn(async (a: Row) => honours(ORDERS, a?.where)[0] ?? null),
  };
  const models = { user, userPreference, systemConfig, order };
  const prisma = {
    ...models,
    getTenantId: jest.fn(() => ambient),
    forTenant: jest.fn(() => models), // UNSCOPED: the production hole
  };
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
  const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
  return { prisma, email, deliveries, models };
}

async function build(h: ReturnType<typeof makeFake>) {
  const mod = await Test.createTestingModule({
    providers: [
      StaffOrderEmailService,
      { provide: PrismaService, useValue: h.prisma },
      { provide: EmailService, useValue: h.email },
      { provide: EmailDeliveryService, useValue: h.deliveries },
    ],
  }).compile();
  return mod.get(StaffOrderEmailService);
}

describe("StaffOrderEmailService tenant scoping (#2872 B1)", () => {
  beforeEach(() => {
    process.env.STAFF_ORDER_EMAIL = "dark";
  });
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  it("(a) notify for tenant A reaches only A's admins and A's staffCc, rows carry tenant A", async () => {
    const h = makeFake("A");
    const svc = await build(h);
    await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ordA" });
    const rows = h.deliveries.record.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.toAddress).sort()).toEqual(["admin@a.test", "cc@a.test"]);
    for (const r of rows) expect(r.tenantId).toBe("A");
  });

  it("(b) no ambient tenant: refused, nothing queried for users, no rows, no send, no throw", async () => {
    const h = makeFake(null);
    const svc = await build(h);
    await expect(
      svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ordA" }),
    ).resolves.toBeUndefined();
    expect(h.models.user.findMany).not.toHaveBeenCalled();
    expect(h.models.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(h.deliveries.record).not.toHaveBeenCalled();
    expect(h.email.send).not.toHaveBeenCalled();
  });

  it("(c) ambient tenant B but the order is in A: same refusal", async () => {
    const h = makeFake("B");
    const svc = await build(h);
    await expect(
      svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ordA" }),
    ).resolves.toBeUndefined();
    // The mismatch half of the guard: without it recipients would still resolve by order.tenantId
    // (A) and A's rows would be written while B is ambient. Nothing may be queried or written.
    expect(h.prisma.getTenantId).toHaveBeenCalled();
    expect(h.models.user.findMany).not.toHaveBeenCalled();
    expect(h.models.userPreference.findMany).not.toHaveBeenCalled();
    expect(h.models.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(h.models.systemConfig.findMany).not.toHaveBeenCalled();
    expect(h.deliveries.record).toHaveBeenCalledTimes(0);
    expect(h.email.send).toHaveBeenCalledTimes(0);
  });

  it("(d) every user / userPreference / systemConfig query carries where.tenantId === order.tenantId", async () => {
    const h = makeFake("A");
    const svc = await build(h);
    await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ordA" });
    const calls = [
      ...h.models.user.findMany.mock.calls,
      ...h.models.userPreference.findMany.mock.calls,
      ...h.models.systemConfig.findFirst.mock.calls,
      ...h.models.systemConfig.findMany.mock.calls,
    ];
    expect(h.models.user.findMany).toHaveBeenCalled();
    expect(h.models.systemConfig.findFirst).toHaveBeenCalled();
    expect(h.models.userPreference.findMany).toHaveBeenCalled();
    for (const c of calls) expect(c[0].where.tenantId).toBe("A");
  });

  it("resolveRecipients(tenantId) uses its argument, not the ambient client", async () => {
    const h = makeFake(null);
    const svc = await build(h);
    expect(await svc.resolveRecipients("B")).toEqual(["admin@b.test", "cc@b.test"]);
  });
});
