import { ForbiddenException } from "@nestjs/common";
import {
  DELIVERY_FIX_KEY_VALUES,
  MessagingDeliveriesService,
  fixKeyForError,
  maskEmail,
} from "./messaging-deliveries.service";
import type { DeliveryHealth, DeliveryRow } from "@routeflow/types";
import { EMAIL_KINDS, EMAIL_KIND_AUDIENCE, PLATFORM_AUDIENCE_KINDS } from "../email/email-kinds";

describe("maskEmail", () => {
  it("masks the local part after the first char", () => {
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
  });
  it("single-char local part", () => {
    expect(maskEmail("j@example.com")).toBe("j***@example.com");
  });
  it("never leaks the local part", () => {
    expect(maskEmail("johnathan.smith@acme.io")).not.toContain("ohnathan");
  });
});

describe("fixKeyForError (closed mapper)", () => {
  it("exposes the closed key set", () => {
    expect([...DELIVERY_FIX_KEY_VALUES]).toEqual([
      "NO_FROM_ADDRESS",
      "MAILBOX_REVOKED",
      "SMTP_AUTH",
      "UNCONFIGURED",
      "OTHER",
    ]);
  });

  const table: [string | null, string | null][] = [
    ["Set a From email in Settings → Email", "NO_FROM_ADDRESS"],
    ["Google mailbox access was revoked", "MAILBOX_REVOKED"],
    ["535 5.7.8 Authentication failed", "SMTP_AUTH"],
    ["SMTP auth error", "SMTP_AUTH"],
    ["Email is not configured", "UNCONFIGURED"],
    ["connection reset by peer", "OTHER"],
    [null, null],
  ];
  it.each(table)("%s => %s", (err, expected) => {
    expect(fixKeyForError(err)).toBe(expected);
  });
});

describe("MessagingDeliveriesService", () => {
  const NOW = new Date("2026-09-30T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  function dbRow(over: Record<string, unknown> = {}) {
    return {
      id: "d1",
      tenantId: "t1",
      kind: "STAFF_NEW_ORDER",
      toAddress: "jane@example.com",
      status: "SENT",
      error: null,
      entityType: "Order",
      entityId: "o1",
      createdAt: new Date(NOW.getTime() - DAY),
      sentAt: new Date(NOW.getTime() - DAY),
      ...over,
    };
  }

  function make(rows: unknown[] = [dbRow()], total = rows.length) {
    const emailDelivery = {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(total),
      groupBy: jest.fn().mockResolvedValue([]),
    };
    const models = { emailDelivery };
    const prisma = {
      ...models,
      forTenant: jest.fn().mockReturnValue(models),
      getTenantId: jest.fn().mockReturnValue("t1"),
    } as any;
    return { svc: new MessagingDeliveriesService(prisma), emailDelivery, prisma };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("list()", () => {
    it("TENANT_ADMIN sees the full toAddress", async () => {
      const { svc } = make();
      const out = await svc.list("TENANT_ADMIN", {});
      const item: DeliveryRow = out.items[0];
      expect(item.toAddress).toBe("jane@example.com");
    });

    it("a stored kind outside the EMAIL_KINDS allow-list is mapped to AUTH_OTHER", async () => {
      const { svc } = make([
        dbRow({ kind: "SOMETHING_NEW" }),
        dbRow({ id: "d2", kind: "INVOICE_SENT" }),
      ]);
      const out = await svc.list("TENANT_ADMIN", {});
      expect(out.items.map((i) => i.kind)).toEqual(["AUTH_OTHER", "INVOICE_SENT"]);
    });

    it("OPERATOR sees a masked address", async () => {
      const { svc } = make();
      const out = await svc.list("OPERATOR", {});
      expect(out.items[0].toAddress).toBe("j***@example.com");
    });

    it("the raw error text is TENANT_ADMIN only: an OPERATOR gets null", async () => {
      const { svc } = make([dbRow({ status: "FAILED", error: "boom" })]);
      expect((await svc.list("TENANT_ADMIN", {})).items[0].error).toBe("boom");
      expect((await svc.list("OPERATOR", {})).items[0].error).toBeNull();
    });

    it("serialises dates as ISO strings and keeps the row shape", async () => {
      const { svc } = make();
      const out = await svc.list("TENANT_ADMIN", {});
      expect(out.items[0]).toEqual({
        id: "d1",
        kind: "STAFF_NEW_ORDER",
        toAddress: "jane@example.com",
        status: "SENT",
        error: null,
        entityType: "Order",
        entityId: "o1",
        createdAt: new Date(NOW.getTime() - DAY).toISOString(),
        sentAt: new Date(NOW.getTime() - DAY).toISOString(),
      });
    });

    it("is tenant-scoped via prisma.forTenant()", async () => {
      const { svc, prisma } = make();
      await svc.list("TENANT_ADMIN", {});
      expect(prisma.forTenant).toHaveBeenCalled();
    });

    it("only the last 30 days, newest first", async () => {
      const { svc, emailDelivery } = make();
      await svc.list("TENANT_ADMIN", {});
      const arg = emailDelivery.findMany.mock.calls[0][0];
      const gte: Date = arg.where.createdAt.gte;
      expect(gte.getTime()).toBe(NOW.getTime() - 30 * DAY);
      expect(arg.orderBy).toEqual(expect.objectContaining({ createdAt: "desc" }));
    });

    it("status filter is applied to where", async () => {
      const { svc, emailDelivery } = make();
      await svc.list("TENANT_ADMIN", { status: "FAILED" });
      expect(emailDelivery.findMany.mock.calls[0][0].where.status).toBe("FAILED");
      expect(emailDelivery.count.mock.calls[0][0].where.status).toBe("FAILED");
    });

    it("no status => no status predicate", async () => {
      const { svc, emailDelivery } = make();
      await svc.list("TENANT_ADMIN", {});
      expect(emailDelivery.findMany.mock.calls[0][0].where.status).toBeUndefined();
    });

    it("pages with skip/take and echoes page, pageSize, total", async () => {
      const { svc, emailDelivery } = make([dbRow()], 57);
      const out = await svc.list("TENANT_ADMIN", { page: 3, pageSize: 20 });
      const arg = emailDelivery.findMany.mock.calls[0][0];
      expect(arg.skip).toBe(40);
      expect(arg.take).toBe(20);
      expect(out).toEqual(expect.objectContaining({ page: 3, pageSize: 20, total: 57 }));
    });

    it("defaults to page 1 and a bounded pageSize", async () => {
      const { svc, emailDelivery } = make();
      const out = await svc.list("TENANT_ADMIN", {});
      expect(out.page).toBe(1);
      expect(out.pageSize).toBeGreaterThan(0);
      expect(emailDelivery.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(100);
    });

    it("clamps an absurd pageSize", async () => {
      const { svc, emailDelivery } = make();
      await svc.list("TENANT_ADMIN", { pageSize: 100000 });
      expect(emailDelivery.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(100);
    });
  });

  describe("health()", () => {
    it("7-day window, counts per status (zero-filled) and failure fix keys", async () => {
      const { svc, emailDelivery } = make();
      emailDelivery.groupBy.mockResolvedValue([
        { status: "SENT", _count: { _all: 9 } },
        { status: "FAILED", _count: { _all: 3 } },
      ]);
      emailDelivery.findMany.mockResolvedValue([
        { error: "Set a From email in Settings → Email" },
        { error: "Set a From email in Settings → Email" },
        { error: "535 auth failed" },
      ]);
      const h: DeliveryHealth = await svc.health();
      expect(h.windowDays).toBe(7);
      expect(h.counts.SENT).toBe(9);
      expect(h.counts.FAILED).toBe(3);
      for (const s of ["QUEUED", "BOUNCED", "WOULD_SEND", "OPTED_OUT"] as const) {
        expect(h.counts[s]).toBe(0);
      }
      expect(h.failures).toEqual(
        expect.arrayContaining([
          { fixKey: "NO_FROM_ADDRESS", count: 2 },
          { fixKey: "SMTP_AUTH", count: 1 },
        ]),
      );
    });

    it("queries only the last 7 days, tenant-scoped", async () => {
      const { svc, emailDelivery, prisma } = make();
      await svc.health();
      expect(prisma.forTenant).toHaveBeenCalled();
      const where = (
        emailDelivery.groupBy.mock.calls[0]?.[0] ?? emailDelivery.count.mock.calls[0][0]
      ).where;
      expect(where.createdAt.gte.getTime()).toBe(NOW.getTime() - 7 * DAY);
    });

    it("no failures => empty failures array", async () => {
      const { svc } = make([]);
      const h = await svc.health();
      expect(h.failures).toEqual([]);
    });
  });

  describe("no tenant context (SUPER_ADMIN / job): refused", () => {
    it.each([
      ["list", (svc: MessagingDeliveriesService) => svc.list("TENANT_ADMIN", {})],
      ["health", (svc: MessagingDeliveriesService) => svc.health()],
    ])("%s throws a coded 403 and never touches the unscoped client", async (_l, call) => {
      const { svc, prisma } = make();
      prisma.getTenantId.mockReturnValue(null);
      const err: any = await call(svc).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
      expect(prisma.forTenant).not.toHaveBeenCalled();
    });
  });
});

describe("email kind audience (a platform-to-tenant mail never shows in the tenant's own delivery views)", () => {
  it("every kind declares an audience, and the platform set is derived from that one registry", () => {
    expect(Object.keys(EMAIL_KIND_AUDIENCE).sort()).toEqual([...EMAIL_KINDS].sort());
    for (const k of EMAIL_KINDS) expect(["tenant", "platform"]).toContain(EMAIL_KIND_AUDIENCE[k]);
    expect([...PLATFORM_AUDIENCE_KINDS].sort()).toEqual(
      EMAIL_KINDS.filter((k) => EMAIL_KIND_AUDIENCE[k] === "platform").sort(),
    );
  });

  it("the failed-payment billing mail is a platform-audience kind; tenant mail kinds are not", () => {
    expect(EMAIL_KIND_AUDIENCE.PAYMENT_FAILED).toBe("platform");
    for (const k of ["STAFF_NEW_ORDER", "INVOICE_SENT", "RECEIPT", "Z_REPORT"] as const) {
      expect(EMAIL_KIND_AUDIENCE[k]).toBe("tenant");
    }
  });

  describe("MessagingDeliveriesService filters on the registry, not on a hard-coded kind", () => {
    function make() {
      const emailDelivery = {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      };
      const prisma = {
        emailDelivery,
        forTenant: jest.fn().mockReturnValue({ emailDelivery }),
        getTenantId: jest.fn().mockReturnValue("t1"),
      } as any;
      return { svc: new MessagingDeliveriesService(prisma), emailDelivery };
    }

    it("list(): rows and count both exclude every platform-audience kind", async () => {
      const { svc, emailDelivery } = make();
      await svc.list("TENANT_ADMIN", {});
      expect(emailDelivery.findMany.mock.calls[0][0].where.kind).toEqual({
        notIn: [...PLATFORM_AUDIENCE_KINDS],
      });
      expect(emailDelivery.count.mock.calls[0][0].where.kind).toEqual({
        notIn: [...PLATFORM_AUDIENCE_KINDS],
      });
      expect(PLATFORM_AUDIENCE_KINDS).toContain("PAYMENT_FAILED");
    });

    it("health(): the status counts AND the failure sample exclude platform-audience kinds", async () => {
      const { svc, emailDelivery } = make();
      await svc.health();
      expect(emailDelivery.groupBy.mock.calls[0][0].where.kind).toEqual({
        notIn: [...PLATFORM_AUDIENCE_KINDS],
      });
      expect(emailDelivery.findMany.mock.calls[0][0].where.kind).toEqual({
        notIn: [...PLATFORM_AUDIENCE_KINDS],
      });
    });
  });
});
