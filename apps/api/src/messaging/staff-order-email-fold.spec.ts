import { Test } from "@nestjs/testing";
import { StaffOrderEmailService } from "./staff-order-email";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import { PolicyService } from "../policy/policy.service";

/**
 * SA-1063 A-1 — the fold. The merge sweep keeps the NEWEST order and deletes the older ones, so an order the
 * office was told about can vanish into a new number. `notifyBuyerOrderPlaced` reads `pendingBefore` (taken before
 * the sweep) and the delivery rows to decide: one edit email naming both numbers, a plain edit, a new-order email,
 * or nothing. These are the service-level rows; the real-merge rows are `staff-order-email-fold.db.spec.ts`.
 */

type Told = Record<string, Array<"STAFF_NEW_ORDER" | "BUYER_ORDER_EDITED">>;

function makeHarness(
  opts: {
    survivor?: { id: string; orderNumber: string; urgent?: boolean };
    exists?: string[]; // folded-order ids that still exist as orders
    told?: Told; // delivery kinds per order id
    pending?: Array<{ id: string; orderNumber: string }>; // the pendingOrdersOf read
    customerId?: string | null;
    failFindMany?: boolean;
  } = {},
) {
  const survivor = opts.survivor ?? { id: "new-2", orderNumber: "ORD-00002" };
  const told = opts.told ?? {};
  const order = {
    findFirst: jest.fn(async (a: { select?: unknown }) => {
      const base = {
        id: survivor.id,
        tenantId: "t1",
        orderNumber: survivor.orderNumber,
        urgent: survivor.urgent ?? false,
        total: 100,
        status: "PENDING",
        customer: { name: "Acme Deli", businessName: "Acme Deli" },
      };
      return a?.select ? { status: base.status } : base;
    }),
    findMany: jest.fn(
      async (a: { where: { id?: { in: string[] }; customerId?: string }; take?: number }) => {
        if (opts.failFindMany) throw new Error("db down");
        if (a.where.id) {
          return a.where.id.in.filter((i) => (opts.exists ?? []).includes(i)).map((id) => ({ id }));
        }
        return (opts.pending ?? []).slice(0, a.take);
      },
    ),
  };
  const emailDelivery = {
    findFirst: jest.fn(async (a: { where: { kind: string; entityId: string } }) =>
      (told[a.where.entityId] ?? []).includes(a.where.kind as never) ? { id: "d" } : null,
    ),
    findMany: jest.fn(
      async (a: { where: { kind: { in: string[] }; entityId: { in: string[] } } }) =>
        a.where.entityId.in.flatMap((entityId) =>
          (told[entityId] ?? [])
            .filter((k) => a.where.kind.in.includes(k))
            .map(() => ({ entityId })),
        ),
    ),
  };
  const customer = {
    findFirst: jest.fn(async () => (opts.customerId === null ? null : { id: "c1" })),
  };
  const user = {
    findMany: jest
      .fn()
      .mockResolvedValue([{ id: "u1", email: "admin1@example.com", role: "TENANT_ADMIN" }]),
  };
  const models = {
    order,
    emailDelivery,
    customer,
    user,
    userPreference: { findMany: jest.fn().mockResolvedValue([]) },
    systemConfig: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = { forTenant: jest.fn(() => models), getTenantId: jest.fn(() => "t1") };
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
  const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
  const policies = { resolve: jest.fn().mockResolvedValue("on") };
  return { prisma, email, deliveries, policies, models };
}

async function build(h: ReturnType<typeof makeHarness>): Promise<StaffOrderEmailService> {
  const mod = await Test.createTestingModule({
    providers: [
      StaffOrderEmailService,
      { provide: PrismaService, useValue: h.prisma },
      { provide: EmailService, useValue: h.email },
      { provide: EmailDeliveryService, useValue: h.deliveries },
      { provide: PolicyService, useValue: h.policies },
    ],
  }).compile();
  return mod.get(StaffOrderEmailService);
}

const sent = (h: ReturnType<typeof makeHarness>) =>
  h.email.send.mock.calls.map(
    (c) => c[0] as { subject: string; html: string; delivery: { kind: string; entityId: string } },
  );

const OLD = { id: "old-1", orderNumber: "ORD-00001" };

describe("SA-1063 A-1 notifyBuyerOrderPlaced fold table", () => {
  beforeEach(() => {
    process.env.STAFF_ORDER_EMAIL = "on";
  });
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  it("F1: new order folded an order staff were told about -> ONE edit email naming both numbers", async () => {
    const h = makeHarness({ told: { "old-1": ["STAFF_NEW_ORDER"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    const mail = sent(h);
    expect(mail).toHaveLength(1);
    expect(mail[0].delivery).toMatchObject({ kind: "BUYER_ORDER_EDITED", entityId: "new-2" });
    expect(mail[0].subject).toBe("Order ORD-00002 replaces ORD-00001 - Acme Deli");
    expect(mail[0].html).toContain("<p>The customer's orders were combined.</p>");
  });

  it("F2: the folded order's only row was an edit row -> still counts as told", async () => {
    const h = makeHarness({ told: { "old-1": ["BUYER_ORDER_EDITED"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sent(h)[0].subject).toContain("replaces ORD-00001");
  });

  it("F3: several folded orders -> one email naming every number", async () => {
    const h = makeHarness({
      told: { "old-1": ["STAFF_NEW_ORDER"], "old-0": ["STAFF_NEW_ORDER"] },
    });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", {
      merged: true,
      pendingBefore: [OLD, { id: "old-0", orderNumber: "ORD-00000" }],
    });
    expect(sent(h)).toHaveLength(1);
    expect(sent(h)[0].subject).toBe("Order ORD-00002 replaces ORD-00001, ORD-00000 - Acme Deli");
  });

  it("F4: a folded order staff were never told about (a draft) is not named; with none told -> new order", async () => {
    const h = makeHarness({ told: {} });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["STAFF_NEW_ORDER"]);
    expect(sent(h)[0].subject).toBe("New order ORD-00002 - Acme Deli");
  });

  it("F5: nothing pending before -> today's new-order email, unchanged", async () => {
    const h = makeHarness();
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: false, pendingBefore: [] });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["STAFF_NEW_ORDER"]);
    expect(sent(h)[0].html).not.toContain("combined");
  });

  it("F6: the pending order still exists (not folded) -> it is not named", async () => {
    const h = makeHarness({ exists: ["old-1"], told: { "old-1": ["STAFF_NEW_ORDER"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: false, pendingBefore: [OLD] });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["STAFF_NEW_ORDER"]);
  });

  it("F7: the survivor is in pendingBefore (the old order survived) -> it is never 'replaced by itself'", async () => {
    const h = makeHarness({
      survivor: { id: "old-1", orderNumber: "ORD-00001" },
      told: { "old-1": ["STAFF_NEW_ORDER"] },
    });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("old-1", { merged: true, pendingBefore: [OLD] });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sent(h)[0].subject).toBe("Order ORD-00001 was edited by the customer - Acme Deli");
  });

  it("F8: survivor already told, an order folded in -> the plain-or-named edit email, once", async () => {
    const h = makeHarness({
      survivor: { id: "old-1", orderNumber: "ORD-00001" },
      told: { "old-1": ["STAFF_NEW_ORDER"], "old-9": ["STAFF_NEW_ORDER"] },
    });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("old-1", {
      merged: true,
      pendingBefore: [OLD, { id: "old-9", orderNumber: "ORD-00009" }],
    });
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["BUYER_ORDER_EDITED"]);
  });

  it("F9: survivor already told, nothing folded, not merged (a replay) -> nothing", async () => {
    const h = makeHarness({ told: { "new-2": ["STAFF_NEW_ORDER"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: false, pendingBefore: [] });
    expect(sent(h)).toHaveLength(0);
    expect(h.deliveries.record).not.toHaveBeenCalled();
  });

  it("F10: survivor told by an edit row only, a fold -> no new-order email on top", async () => {
    const h = makeHarness({
      told: { "new-2": ["BUYER_ORDER_EDITED"], "old-1": ["STAFF_NEW_ORDER"] },
    });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    expect(sent(h).map((m) => m.delivery.kind)).not.toContain("STAFF_NEW_ORDER");
  });

  it("F11: an urgent survivor keeps the [URGENT] prefix on the fold email", async () => {
    const h = makeHarness({
      survivor: { id: "new-2", orderNumber: "ORD-00002", urgent: true },
      told: { "old-1": ["STAFF_NEW_ORDER"] },
    });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    expect(sent(h)[0].subject).toBe("[URGENT] Order ORD-00002 replaces ORD-00001 - Acme Deli");
  });

  it("F12: env off -> no query at all, nothing sent", async () => {
    process.env.STAFF_ORDER_EMAIL = "off";
    const h = makeHarness({ told: { "old-1": ["STAFF_NEW_ORDER"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] });
    expect(h.prisma.forTenant).not.toHaveBeenCalled();
    expect(sent(h)).toHaveLength(0);
  });

  it("F13: a failed fold read never rejects and over-tells: the plain new-order email still goes out", async () => {
    const h = makeHarness({ failFindMany: true });
    const svc = await build(h);
    await expect(
      svc.notifyBuyerOrderPlaced("new-2", { merged: true, pendingBefore: [OLD] }),
    ).resolves.toBeUndefined();
    expect(sent(h).map((m) => m.delivery.kind)).toEqual(["STAFF_NEW_ORDER"]);
  });

  it("F14: the plain edit and new-order emails are byte-identical to before (no 'replaces' wording)", async () => {
    const h = makeHarness({ told: { "new-2": ["STAFF_NEW_ORDER"] } });
    const svc = await build(h);
    await svc.notifyBuyerOrderEdited("new-2");
    expect(sent(h)[0].subject).toBe("Order ORD-00002 was edited by the customer - Acme Deli");
    expect(sent(h)[0].html).not.toContain("combined");
  });
});

describe("SA-1063 A-1 pendingOrdersOf / pendingOrdersForUser", () => {
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  it("P1: returns id + number, newest first, asked for at most 50", async () => {
    const h = makeHarness({ pending: [OLD, { id: "o2", orderNumber: "ORD-00003" }] });
    const svc = await build(h);
    await expect(svc.pendingOrdersOf("c1")).resolves.toEqual([
      OLD,
      { id: "o2", orderNumber: "ORD-00003" },
    ]);
    expect(h.models.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "c1", status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    );
  });

  it("P2: env off -> [] with no query", async () => {
    process.env.STAFF_ORDER_EMAIL = "off";
    const h = makeHarness({ pending: [OLD] });
    const svc = await build(h);
    await expect(svc.pendingOrdersOf("c1")).resolves.toEqual([]);
    expect(h.prisma.forTenant).not.toHaveBeenCalled();
  });

  it("P3: no customer id -> [] with no query", async () => {
    const h = makeHarness({ pending: [OLD] });
    const svc = await build(h);
    await expect(svc.pendingOrdersOf(null)).resolves.toEqual([]);
    expect(h.models.order.findMany).not.toHaveBeenCalled();
  });

  it("P4: a failed read -> [] (the office then gets today's new-order email)", async () => {
    const h = makeHarness({ failFindMany: true });
    const svc = await build(h);
    await expect(svc.pendingOrdersOf("c1")).resolves.toEqual([]);
  });

  it("P5: for a signed-in user, finds their customer first; no customer -> []", async () => {
    const h = makeHarness({ pending: [OLD] });
    const svc = await build(h);
    await expect(svc.pendingOrdersForUser("user-1")).resolves.toEqual([OLD]);
    expect(h.models.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    const none = makeHarness({ pending: [OLD], customerId: null });
    await expect((await build(none)).pendingOrdersForUser("user-1")).resolves.toEqual([]);
  });
});
