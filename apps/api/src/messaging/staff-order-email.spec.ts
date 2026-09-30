import { Test } from "@nestjs/testing";
import { NotificationEvent } from "@prisma/client";
import {
  StaffOrderEmailService,
  effectiveStaffOrderEmailMode,
  shouldNotifyStaffOfOrder,
  type StaffOrderEmailMode,
} from "./staff-order-email";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EmailDeliveryService } from "../email/email-delivery.service";

/**
 * WS4 (SA-606) — staff emails for buyer-placed orders / buyer edits / cancels.
 * Assumption: prisma access goes through either `prisma.<model>` or `prisma.forTenant().<model>`;
 * the mock exposes the SAME jest.fn on both so the spec does not pin which one is used.
 */

type Row = Record<string, unknown>;

function makeHarness(
  opts: {
    users?: Row[];
    prefs?: Row[];
    staffCc?: unknown;
    order?: Row | null;
    order_total?: unknown;
  } = {},
) {
  const user = { findMany: jest.fn().mockResolvedValue(opts.users ?? []) };
  const userPreference = { findMany: jest.fn().mockResolvedValue(opts.prefs ?? []) };
  const systemConfig = {
    findFirst: jest
      .fn()
      .mockResolvedValue(
        opts.staffCc === undefined
          ? null
          : { key: "notifications.staffCc", value: JSON.stringify(opts.staffCc) },
      ),
    findMany: jest
      .fn()
      .mockResolvedValue(
        opts.staffCc === undefined
          ? []
          : [{ key: "notifications.staffCc", value: JSON.stringify(opts.staffCc) }],
      ),
  };
  const order = {
    findFirst: jest.fn().mockResolvedValue(opts.order === undefined ? baseOrder() : opts.order),
    findUnique: jest.fn().mockResolvedValue(opts.order === undefined ? baseOrder() : opts.order),
  };
  const models = { user, userPreference, systemConfig, order };
  const prisma = {
    ...models,
    forTenant: jest.fn().mockReturnValue(models),
    getTenantId: jest.fn().mockReturnValue("t1"),
  };
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
  const deliveries = { record: jest.fn().mockResolvedValue(undefined) };
  return { prisma, email, deliveries, models };
}

function baseOrder(over: Row = {}): Row {
  return {
    id: "ord-1",
    tenantId: "t1",
    orderNumber: "ORD-1001",
    total: 100,
    isUrgent: false,
    customer: { id: "c1", name: "Acme Deli", businessName: "Acme Deli" },
    items: [{ id: "i1", quantity: 2, unitPrice: 10, product: { name: "Widget" }, name: "Widget" }],
    ...over,
  };
}

async function build(h: ReturnType<typeof makeHarness>): Promise<StaffOrderEmailService> {
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

/**
 * ASSUMED SEAM: the policy mode is fixed "dark" in production today, so "on" is reached in
 * specs by overriding the instance field `policyMode` (implementer: expose
 * `policyMode: StaffOrderEmailMode = "dark"` on StaffOrderEmailService).
 */
async function buildOn(opts: Parameters<typeof makeHarness>[0]) {
  process.env.STAFF_ORDER_EMAIL = "on";
  const h = makeHarness(opts);
  const svc = await build(h);
  (svc as unknown as { policyMode: StaffOrderEmailMode }).policyMode = "on";
  return { h, svc };
}

const ADMINS = [
  { id: "u1", email: "Admin1@Example.com", role: "TENANT_ADMIN" },
  { id: "u2", email: "admin2@example.com", role: "TENANT_ADMIN" },
];

describe("effectiveStaffOrderEmailMode (T2 ceiling = min(env, policy))", () => {
  const cases: [string | undefined, StaffOrderEmailMode, StaffOrderEmailMode][] = [
    ["off", "dark", "off"],
    ["dark", "dark", "dark"],
    ["on", "dark", "dark"],
    [undefined, "dark", "dark"],
    ["garbage", "dark", "dark"],
    ["off", "on", "off"],
    ["dark", "on", "dark"],
    ["on", "on", "on"],
    [undefined, "on", "dark"],
    ["garbage", "on", "dark"],
    ["on", "off", "off"],
    ["off", "off", "off"],
  ];
  it.each(cases)("env=%s policy=%s => %s", (env, policy, expected) => {
    expect(effectiveStaffOrderEmailMode(env, policy)).toBe(expected);
  });

  it("an unknown policy value degrades to dark", () => {
    expect(effectiveStaffOrderEmailMode("on", "bogus" as unknown as StaffOrderEmailMode)).toBe(
      "dark",
    );
    expect(effectiveStaffOrderEmailMode(undefined, "bogus" as unknown as StaffOrderEmailMode)).toBe(
      "dark",
    );
  });
});

describe("shouldNotifyStaffOfOrder (one named predicate)", () => {
  const principals = ["CUSTOMER", "STAFF", "DRIVER", "CRON"] as const;
  for (const principal of principals) {
    for (const isDraft of [false, true]) {
      const expected = principal === "CUSTOMER" && !isDraft;
      it(`principal=${principal} isDraft=${isDraft} => ${expected}`, () => {
        expect(shouldNotifyStaffOfOrder({ principal, isDraft })).toBe(expected);
      });
    }
  }
});

describe("StaffOrderEmailService.resolveRecipients (T1 matrix)", () => {
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  it("queries only ACTIVE, non-deleted TENANT_ADMIN users", async () => {
    const h = makeHarness({ users: ADMINS });
    const svc = await build(h);
    await svc.resolveRecipients("t1");
    const arg = h.models.user.findMany.mock.calls[0][0];
    expect(arg.where).toEqual(
      expect.objectContaining({ role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null }),
    );
  });

  it("returns admin emails, deduped by trim+lowercase, never an OPERATOR/SUPER_ADMIN", async () => {
    const h = makeHarness({
      users: [
        ...ADMINS,
        { id: "u3", email: "  ADMIN2@example.com ", role: "TENANT_ADMIN" },
        { id: "u4", email: "op@example.com", role: "OPERATOR" },
        { id: "u5", email: "sa@example.com", role: "SUPER_ADMIN" },
      ],
    });
    const svc = await build(h);
    const out = await svc.resolveRecipients("t1");
    const lower = out.map((e) => e.trim().toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(lower).toEqual(expect.arrayContaining(["admin1@example.com", "admin2@example.com"]));
    expect(lower).not.toContain("op@example.com");
    expect(lower).not.toContain("sa@example.com");
  });

  it("drops sentinel (@placeholder.local / @imported.local) admins and staffCc entries", async () => {
    const h = makeHarness({
      users: [
        ...ADMINS,
        { id: "u7", email: "no-email+abc@placeholder.local", role: "TENANT_ADMIN" },
        { id: "u8", email: "bob@IMPORTED.local", role: "TENANT_ADMIN" },
      ],
      staffCc: ["cc1@example.com", "x@imported.local", "y@placeholder.local"],
    });
    const svc = await build(h);
    const out = (await svc.resolveRecipients("t1")).map((e) => e.toLowerCase());
    expect(out.sort()).toEqual(["admin1@example.com", "admin2@example.com", "cc1@example.com"]);
  });

  it("skips users with an empty email", async () => {
    const h = makeHarness({
      users: [...ADMINS, { id: "u9", email: "", role: "TENANT_ADMIN" }],
    });
    const svc = await build(h);
    const out = await svc.resolveRecipients("t1");
    expect(out).toHaveLength(2);
  });

  it("appends notifications.staffCc (<=5 valid emails, invalid and extras ignored)", async () => {
    const h = makeHarness({
      users: ADMINS,
      staffCc: [
        "cc1@example.com",
        "not-an-email",
        "cc2@example.com",
        "cc3@example.com",
        "cc4@example.com",
        "cc5@example.com",
        "cc6@example.com",
      ],
    });
    const svc = await build(h);
    const out = (await svc.resolveRecipients("t1")).map((e) => e.trim().toLowerCase());
    expect(out).toEqual(expect.arrayContaining(["cc1@example.com", "cc5@example.com"]));
    expect(out).not.toContain("not-an-email");
    expect(out).not.toContain("cc6@example.com");
  });

  it("dedupes a staffCc address that is also an admin", async () => {
    const h = makeHarness({ users: ADMINS, staffCc: ["ADMIN1@example.com"] });
    const svc = await build(h);
    const out = (await svc.resolveRecipients("t1")).map((e) => e.trim().toLowerCase());
    expect(out.filter((e) => e === "admin1@example.com")).toHaveLength(1);
  });

  it("malformed staffCc JSON is ignored, admins still returned", async () => {
    const h = makeHarness({ users: ADMINS });
    h.models.systemConfig.findFirst.mockResolvedValue({
      key: "notifications.staffCc",
      value: "{not json",
    });
    h.models.systemConfig.findMany.mockResolvedValue([
      { key: "notifications.staffCc", value: "{not json" },
    ]);
    const svc = await build(h);
    const out = await svc.resolveRecipients("t1");
    expect(out).toHaveLength(2);
  });
});

describe("StaffOrderEmailService.notifyStaffEvent", () => {
  afterEach(() => {
    delete process.env.STAFF_ORDER_EMAIL;
  });

  describe("T2 mode matrix (policy is fixed dark for now)", () => {
    it("env=off: no rows, no send", async () => {
      process.env.STAFF_ORDER_EMAIL = "off";
      const h = makeHarness({ users: ADMINS });
      const svc = await build(h);
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(h.deliveries.record).not.toHaveBeenCalled();
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it.each(["dark", "on", undefined])(
      "env=%s: one WOULD_SEND row per recipient, email.send never called",
      async (env) => {
        if (env === undefined) delete process.env.STAFF_ORDER_EMAIL;
        else process.env.STAFF_ORDER_EMAIL = env;
        const h = makeHarness({ users: ADMINS });
        const svc = await build(h);
        await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
        expect(h.email.send).not.toHaveBeenCalled();
        expect(h.deliveries.record).toHaveBeenCalledTimes(2);
        for (const call of h.deliveries.record.mock.calls) {
          expect(call[0]).toEqual(
            expect.objectContaining({
              tenantId: "t1",
              kind: "STAFF_NEW_ORDER",
              status: "WOULD_SEND",
              entityType: "Order",
              entityId: "ord-1",
            }),
          );
        }
        const tos = h.deliveries.record.mock.calls.map((c) => String(c[0].toAddress).toLowerCase());
        expect(tos).toEqual(expect.arrayContaining(["admin1@example.com", "admin2@example.com"]));
      },
    );

    it("read failure (order lookup rejects) resolves and sends nothing", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ users: ADMINS });
      h.models.order.findFirst.mockRejectedValue(new Error("db down"));
      h.models.order.findUnique.mockRejectedValue(new Error("db down"));
      const svc = await build(h);
      await expect(
        svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" }),
      ).resolves.toBeUndefined();
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("policy-read failure degrades to dark (no send)", async () => {
      process.env.STAFF_ORDER_EMAIL = "on";
      const h = makeHarness({ users: ADMINS });
      h.models.systemConfig.findFirst.mockRejectedValue(new Error("cfg down"));
      h.models.systemConfig.findMany.mockRejectedValue(new Error("cfg down"));
      const svc = await build(h);
      await expect(
        svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" }),
      ).resolves.toBeUndefined();
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("reads process.env at CALL time, not construction time", async () => {
      process.env.STAFF_ORDER_EMAIL = "off";
      const h = makeHarness({ users: ADMINS });
      const svc = await build(h);
      process.env.STAFF_ORDER_EMAIL = "dark";
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(h.deliveries.record).toHaveBeenCalledTimes(2);
    });
  });

  it("never rejects even when email.send, deliveries.record and prisma all throw", async () => {
    process.env.STAFF_ORDER_EMAIL = "on";
    const h = makeHarness({ users: ADMINS });
    h.email.send.mockRejectedValue(new Error("smtp boom"));
    h.deliveries.record.mockRejectedValue(new Error("audit boom"));
    h.models.user.findMany.mockRejectedValue(new Error("db boom"));
    const svc = await build(h);
    await expect(
      svc.notifyStaffEvent(NotificationEvent.BUYER_ORDER_CANCELLED, { orderId: "ord-1" }),
    ).resolves.toBeUndefined();
  });

  it("missing order => resolves, nothing written or sent", async () => {
    const h = makeHarness({ users: ADMINS, order: null });
    const svc = await build(h);
    await expect(
      svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "nope" }),
    ).resolves.toBeUndefined();
    expect(h.deliveries.record).not.toHaveBeenCalled();
    expect(h.email.send).not.toHaveBeenCalled();
  });

  it("empty recipients => nothing written", async () => {
    process.env.STAFF_ORDER_EMAIL = "dark";
    const h = makeHarness({ users: [] });
    const svc = await build(h);
    await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
    expect(h.deliveries.record).not.toHaveBeenCalled();
    expect(h.email.send).not.toHaveBeenCalled();
  });

  describe("on-mode sending (effective mode 'on')", () => {
    it("one email.send per recipient with a delivery ctx; no WOULD_SEND rows", async () => {
      const { h, svc } = await buildOn({ users: ADMINS });
      await svc.notifyStaffEvent(NotificationEvent.BUYER_ORDER_EDITED, { orderId: "ord-1" });
      expect(h.email.send).toHaveBeenCalledTimes(2);
      for (const call of h.email.send.mock.calls) {
        expect(call[0].delivery).toEqual({
          tenantId: "t1",
          kind: "BUYER_ORDER_EDITED",
          entityType: "Order",
          entityId: "ord-1",
        });
      }
      const statuses = h.deliveries.record.mock.calls.map((c) => c[0].status);
      expect(statuses).not.toContain("WOULD_SEND");
    });

    it("opted-out recipient gets an OPTED_OUT row and no send", async () => {
      const { h, svc } = await buildOn({
        users: ADMINS,
        prefs: [{ userId: "u2", key: "staffOrderEmail", value: "false" }],
      });
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(h.email.send).toHaveBeenCalledTimes(1);
      expect(h.deliveries.record.mock.calls.map((c) => c[0].status)).toEqual(["OPTED_OUT"]);
    });
  });

  describe("kind mapping", () => {
    it.each([
      [NotificationEvent.STAFF_NEW_ORDER, "STAFF_NEW_ORDER"],
      [NotificationEvent.BUYER_ORDER_EDITED, "BUYER_ORDER_EDITED"],
      [NotificationEvent.BUYER_ORDER_CANCELLED, "BUYER_ORDER_CANCELLED"],
    ])("%s => row kind %s", async (event, kind) => {
      process.env.STAFF_ORDER_EMAIL = "dark";
      const h = makeHarness({ users: [ADMINS[0]] });
      const svc = await build(h);
      await svc.notifyStaffEvent(event, { orderId: "ord-1" });
      expect(h.deliveries.record.mock.calls[0][0].kind).toBe(kind);
    });
  });

  describe("opt-outs (OPTED_OUT row, no send)", () => {
    it("staffOrderEmail=false opts a user out of STAFF_NEW_ORDER only", async () => {
      process.env.STAFF_ORDER_EMAIL = "dark";
      const h = makeHarness({
        users: ADMINS,
        prefs: [{ userId: "u1", key: "staffOrderEmail", value: "false" }],
      });
      const svc = await build(h);
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      const rows = h.deliveries.record.mock.calls.map((c) => c[0]);
      const opted = rows.filter((r) => r.status === "OPTED_OUT");
      const would = rows.filter((r) => r.status === "WOULD_SEND");
      expect(opted).toHaveLength(1);
      expect(String(opted[0].toAddress).toLowerCase()).toBe("admin1@example.com");
      expect(would).toHaveLength(1);
      expect(h.email.send).not.toHaveBeenCalled();
    });

    it("staffOrderEmail=false does NOT opt out of BUYER_ORDER_EDITED", async () => {
      process.env.STAFF_ORDER_EMAIL = "dark";
      const h = makeHarness({
        users: [ADMINS[0]],
        prefs: [{ userId: "u1", key: "staffOrderEmail", value: "false" }],
      });
      const svc = await build(h);
      await svc.notifyStaffEvent(NotificationEvent.BUYER_ORDER_EDITED, { orderId: "ord-1" });
      expect(h.deliveries.record.mock.calls.map((c) => c[0].status)).toEqual(["WOULD_SEND"]);
    });

    it.each([NotificationEvent.BUYER_ORDER_EDITED, NotificationEvent.BUYER_ORDER_CANCELLED])(
      "staffBuyerChangeEmail=false opts out of %s",
      async (event) => {
        process.env.STAFF_ORDER_EMAIL = "dark";
        const h = makeHarness({
          users: [ADMINS[0]],
          prefs: [{ userId: "u1", key: "staffBuyerChangeEmail", value: "false" }],
        });
        const svc = await build(h);
        await svc.notifyStaffEvent(event, { orderId: "ord-1" });
        expect(h.deliveries.record.mock.calls.map((c) => c[0].status)).toEqual(["OPTED_OUT"]);
      },
    );

    it("a preference other than the string 'false' does not opt out", async () => {
      process.env.STAFF_ORDER_EMAIL = "dark";
      const h = makeHarness({
        users: [ADMINS[0]],
        prefs: [{ userId: "u1", key: "staffOrderEmail", value: "true" }],
      });
      const svc = await build(h);
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(h.deliveries.record.mock.calls.map((c) => c[0].status)).toEqual(["WOULD_SEND"]);
    });
  });

  describe("content (on mode)", () => {
    it("urgent order subject starts with [URGENT] ", async () => {
      const { h, svc } = await buildOn({
        users: [ADMINS[0]],
        order: baseOrder({ isUrgent: true }),
      });
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(h.email.send).toHaveBeenCalledTimes(1);
      expect(String(h.email.send.mock.calls[0][0].subject).startsWith("[URGENT] ")).toBe(true);
    });

    it("non-urgent subject has no [URGENT] prefix", async () => {
      const { h, svc } = await buildOn({ users: [ADMINS[0]] });
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      expect(String(h.email.send.mock.calls[0][0].subject)).not.toContain("[URGENT]");
    });

    it("body shows the STORED order.total at 2dp, never recomputed from line items", async () => {
      const { h, svc } = await buildOn({
        users: [ADMINS[0]],
        order: baseOrder({
          total: 123.4,
          items: [{ id: "i1", quantity: 2, unitPrice: 10, product: { name: "Widget" } }],
        }),
      });
      await svc.notifyStaffEvent(NotificationEvent.STAFF_NEW_ORDER, { orderId: "ord-1" });
      const html = String(h.email.send.mock.calls[0][0].html);
      expect(html).toContain("123.40");
      expect(html).not.toContain("20.00");
    });
  });
});
