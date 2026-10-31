import { Test } from "@nestjs/testing";
import {
  BUYER_EDIT_EMAIL_WINDOW_MS,
  StaffOrderEmailService,
  type StaffOrderEmailMode,
} from "./staff-order-email";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";
import { PolicyService } from "../policy/policy.service";

/**
 * SA-1063 — the buyer-event entry points of `StaffOrderEmailService` (placed / edited / cancelled) and the
 * tenant policy `notifications.staffOrderEmail` under the platform env ceiling. Rows R1-R8, R10, R12, R13,
 * R17 of the spec at the service level; the route wiring is `staff-order-email-routes.spec.ts` and
 * `buyer.controller.staff-order-email.spec.ts`.
 */

type Row = Record<string, unknown>;

function makeHarness(
  opts: {
    status?: string | null; // order status; null = no such order
    told?: Partial<Record<string, boolean>>; // delivery rows that exist, by kind
    prefs?: Row[];
    policy?: string;
  } = {},
) {
  const order = {
    findFirst: jest.fn(async (a: { select?: unknown }) => {
      if (opts.status === null) return null;
      const base = {
        id: "ord-1",
        tenantId: "t1",
        orderNumber: "ORD-1001",
        total: 100,
        status: opts.status ?? "PENDING",
        customer: { name: "Acme Deli", businessName: "Acme Deli" },
      };
      return a?.select ? { status: base.status } : base;
    }),
  };
  const emailDelivery = {
    findFirst: jest.fn(async (a: { where: { kind: string } }) =>
      opts.told?.[a.where.kind] ? { id: "d1" } : null,
    ),
  };
  const user = {
    findMany: jest.fn().mockResolvedValue([
      { id: "u1", email: "admin1@example.com", role: "TENANT_ADMIN" },
      { id: "u2", email: "admin2@example.com", role: "TENANT_ADMIN" },
    ]),
  };
  const userPreference = { findMany: jest.fn().mockResolvedValue(opts.prefs ?? []) };
  const systemConfig = { findFirst: jest.fn().mockResolvedValue(null) };
  const models = { order, emailDelivery, user, userPreference, systemConfig };
  const prisma = { forTenant: jest.fn(() => models), getTenantId: jest.fn(() => "t1") };
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
  const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
  const policies = { resolve: jest.fn().mockResolvedValue(opts.policy ?? "dark") };
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

const recorded = (h: ReturnType<typeof makeHarness>) =>
  h.deliveries.record.mock.calls.map(
    (c) => c[0] as { kind: string; status: string; toAddress: string },
  );
const sentKinds = (h: ReturnType<typeof makeHarness>) =>
  h.email.send.mock.calls.map((c) => (c[0] as { delivery: { kind: string } }).delivery.kind);

describe("SA-1063 StaffOrderEmailService buyer events", () => {
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  describe("placed", () => {
    it("R1: env on + policy on, no earlier row -> one real STAFF_NEW_ORDER mail per admin", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on" });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(h.email.send).toHaveBeenCalledTimes(2);
      expect(sentKinds(h)).toEqual(["STAFF_NEW_ORDER", "STAFF_NEW_ORDER"]);
      expect(h.deliveries.record).not.toHaveBeenCalled();
    });

    it("R2: policy at its default (dark) -> WOULD_SEND per admin, no mail", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness();
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(recorded(h).map((r) => r.status)).toEqual(["WOULD_SEND", "WOULD_SEND"]);
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("R3: env dark + policy on -> WOULD_SEND, no mail (the ceiling holds)", async () => {
      process.env.STAFF_ORDER_EMAIL = "dark";
      const h = makeHarness({ policy: "on" });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(recorded(h).map((r) => r.status)).toEqual(["WOULD_SEND", "WOULD_SEND"]);
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("R4: env off -> no rows, no mail, and no query or policy read at all", async () => {
      process.env.STAFF_ORDER_EMAIL = "off";
      const h = makeHarness({ policy: "on" });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(h.deliveries.record).not.toHaveBeenCalled();
      expect(h.email.send).not.toHaveBeenCalled();
      expect(h.models.order.findFirst).not.toHaveBeenCalled();
      expect(h.policies.resolve).not.toHaveBeenCalled();
    });

    it("R5: a row already exists and the cart did not fold (an idempotent replay) -> nothing", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", told: { STAFF_NEW_ORDER: true } });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(h.email.send).not.toHaveBeenCalled();
      expect(h.deliveries.record).not.toHaveBeenCalled();
    });

    it("R6: a row exists and the cart folded into it -> BUYER_ORDER_EDITED, not a second new-order mail", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", told: { STAFF_NEW_ORDER: true } });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: true });
      expect(sentKinds(h)).toEqual(["BUYER_ORDER_EDITED", "BUYER_ORDER_EDITED"]);
    });

    it("R6b: the fold's edit mail honours the edit window (a retried fold sends once)", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({
        policy: "on",
        told: { STAFF_NEW_ORDER: true, BUYER_ORDER_EDITED: true },
      });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: true });
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("R10: a DRAFT order is no event", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", status: "DRAFT" });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(h.email.send).not.toHaveBeenCalled();
      expect(h.deliveries.record).not.toHaveBeenCalled();
    });
  });

  describe("edited", () => {
    it("R7: the first edit sends; an edit row inside the window skips the second", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const first = makeHarness({ policy: "on" });
      await (await build(first)).notifyBuyerOrderEdited("ord-1");
      expect(sentKinds(first)).toEqual(["BUYER_ORDER_EDITED", "BUYER_ORDER_EDITED"]);

      const second = makeHarness({ policy: "on", told: { BUYER_ORDER_EDITED: true } });
      await (await build(second)).notifyBuyerOrderEdited("ord-1");
      expect(second.email.send).not.toHaveBeenCalled();
    });

    it("R7b: the window lookup is one named constant (10 minutes) on the order's own rows", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      expect(BUYER_EDIT_EMAIL_WINDOW_MS).toBe(10 * 60 * 1000);
      const h = makeHarness({ policy: "on" });
      const before = Date.now();
      await (await build(h)).notifyBuyerOrderEdited("ord-1");
      const where = h.models.emailDelivery.findFirst.mock.calls[0][0].where as Row & {
        createdAt: { gte: Date };
      };
      expect(where).toMatchObject({ tenantId: "t1", entityType: "Order", entityId: "ord-1" });
      const gte = where.createdAt.gte.getTime();
      expect(gte).toBeGreaterThanOrEqual(before - BUYER_EDIT_EMAIL_WINDOW_MS - 1000);
      expect(gte).toBeLessThanOrEqual(Date.now() - BUYER_EDIT_EMAIL_WINDOW_MS + 1000);
    });

    it("R10: a draft edit is no event", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", status: "DRAFT" });
      await (await build(h)).notifyBuyerOrderEdited("ord-1");
      expect(h.email.send).not.toHaveBeenCalled();
    });
  });

  describe("cancelled", () => {
    it("R8: a cancel of a real order sends BUYER_ORDER_CANCELLED", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", status: "CANCELLED" });
      await (await build(h)).notifyBuyerOrderCancelled("ord-1", { wasDraft: false });
      expect(sentKinds(h)).toEqual(["BUYER_ORDER_CANCELLED", "BUYER_ORDER_CANCELLED"]);
    });

    it("R8b: a draft cancel (read before the cancel) sends nothing", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on", status: "CANCELLED" });
      await (await build(h)).notifyBuyerOrderCancelled("ord-1", { wasDraft: true });
      expect(h.email.send).not.toHaveBeenCalled();
      expect(h.deliveries.record).not.toHaveBeenCalled();
    });

    it("orderIsDraft reads the status; a missing order or a failed read counts as a draft", async () => {
      const draft = makeHarness({ status: "DRAFT" });
      expect(await (await build(draft)).orderIsDraft("ord-1")).toBe(true);
      const live = makeHarness({ status: "PENDING" });
      expect(await (await build(live)).orderIsDraft("ord-1")).toBe(false);
      const gone = makeHarness({ status: null });
      expect(await (await build(gone)).orderIsDraft("ord-1")).toBe(true);
      const broken = makeHarness();
      broken.models.order.findFirst.mockRejectedValueOnce(new Error("db down"));
      expect(await (await build(broken)).orderIsDraft("ord-1")).toBe(true);
    });
  });

  describe("guards", () => {
    it("R12: the email provider throws -> the method still resolves", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on" });
      h.email.send.mockRejectedValue(new Error("smtp down"));
      await expect(
        (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false }),
      ).resolves.toBeUndefined();
    });

    it("R12b: the delivery lookup throws -> the method still resolves", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "on" });
      h.models.emailDelivery.findFirst.mockRejectedValue(new Error("db down"));
      const svc = await build(h);
      await expect(svc.notifyBuyerOrderPlaced("ord-1", { merged: false })).resolves.toBeUndefined();
      await expect(svc.notifyBuyerOrderEdited("ord-1")).resolves.toBeUndefined();
    });

    it("R13: an invalid policy value reads as dark -> WOULD_SEND, no mail", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ policy: "bogus" });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(recorded(h).map((r) => r.status)).toEqual(["WOULD_SEND", "WOULD_SEND"]);
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("R17: an admin who opted out gets an OPTED_OUT row and no mail", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({
        policy: "on",
        prefs: [{ userId: "u1", key: "staffOrderEmail", value: "false" }],
      });
      await (await build(h)).notifyBuyerOrderPlaced("ord-1", { merged: false });
      expect(recorded(h).find((r) => r.toAddress === "admin1@example.com")?.status).toBe(
        "OPTED_OUT",
      );
      expect(h.email.send).toHaveBeenCalledTimes(1);
    });

    it("the effective mode is per tenant: env ceiling min the tenant's policy", async () => {
      const table: Array<[string | undefined, string, StaffOrderEmailMode]> = [
        ["on", "on", "on"],
        ["on", "dark", "dark"],
        ["on", "off", "off"],
        ["dark", "on", "dark"],
        [undefined, "on", "dark"],
        ["off", "on", "off"],
      ];
      for (const [env, policy, want] of table) {
        if (env === undefined) delete process.env.STAFF_ORDER_EMAIL;
        else process.env.STAFF_ORDER_EMAIL = env;
        const h = makeHarness({ policy });
        expect(await (await build(h)).getEffectiveMode("t1")).toBe(want);
        if (env === "off") expect(h.policies.resolve).not.toHaveBeenCalled();
        else
          expect(h.policies.resolve).toHaveBeenCalledWith(
            "t1",
            "notifications.staffOrderEmail",
            {},
          );
      }
    });
  });
});
