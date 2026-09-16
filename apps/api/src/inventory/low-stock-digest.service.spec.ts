// `@LeaderCron` wraps every tick in a Postgres advisory lock (common/cron-lock.ts). These
// specs invoke the tick directly and have no database, so the lock is a pass-through here —
// same convention as billing-cron.service.spec.ts.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { LowStockDigestService, LOW_STOCK_DIGEST_PREF_KEY } from "./low-stock-digest.service";

// 2026-09-16T11:30:00Z = 07:30 America/New_York (EDT, UTC-4 in September) — inside the
// 07:00 tenant-local hour the digest fires in. Tests that must NOT fire use a different
// hour (e.g. 09:00Z ⇒ 05:00 EDT) instead of mutating this one, so every "fires" assertion
// keeps using the exact instant the digest is meant to trigger on.
const AT_SEVEN_LOCAL = new Date("2026-09-16T11:30:00.000Z");
const AT_FIVE_LOCAL = new Date("2026-09-16T09:30:00.000Z");

function makeAdmin(id: string, email: string) {
  return { id, email, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null };
}

function make(
  data: {
    tenants?: any[];
    products?: any[];
    admins?: any[];
    optOuts?: any[];
    sendResult?: { delivered: boolean; transport: string; error?: string };
    sendImpl?: (...args: any[]) => Promise<any>;
  } = {},
) {
  const prisma = {
    tenant: { findMany: jest.fn().mockResolvedValue(data.tenants ?? []) },
    product: { findMany: jest.fn().mockResolvedValue(data.products ?? []) },
    user: { findMany: jest.fn().mockResolvedValue(data.admins ?? []) },
    userPreference: { findMany: jest.fn().mockResolvedValue(data.optOuts ?? []) },
    tenantConfig: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as any;
  const email = {
    sendLowStockDigest: data.sendImpl
      ? jest.fn(data.sendImpl)
      : jest.fn().mockResolvedValue(data.sendResult ?? { delivered: true, transport: "resend" }),
  } as any;
  const svc = new LowStockDigestService(prisma, email);
  return { svc, prisma, email };
}

const tenant = (
  overrides: Partial<{
    id: string;
    timezone: string;
    businessName: string | null;
    lowStockDigestSentForDay: Date | null;
  }> = {},
) => ({
  id: overrides.id ?? "t1",
  config: {
    timezone: overrides.timezone ?? "America/New_York",
    businessName: overrides.businessName ?? "Acme Wholesale",
    lowStockDigestSentForDay: overrides.lowStockDigestSentForDay ?? null,
  },
});

const product = (
  over: Partial<{
    name: string;
    sku: string | null;
    currentStock: number;
    reorderPoint: number | null;
  }> = {},
) => ({
  name: over.name ?? "Widget",
  // `?? "W-1"` would silently override an explicit `sku: null` fixture — use `in` so a
  // caller can distinguish "not provided" (default) from "explicitly null" (no SKU on file).
  sku: "sku" in over ? (over.sku as string | null) : "W-1",
  currentStock: over.currentStock ?? 3,
  reorderPoint: over.reorderPoint ?? 10,
});

describe("LowStockDigestService (N4)", () => {
  describe("digest content", () => {
    it("REG-N4: sends one digest per admin, with exactly the below-threshold items, correctly mapped", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [
          product({ name: "Low Widget", sku: "LOW-1", currentStock: 2, reorderPoint: 10 }),
          product({ name: "Zero Widget", sku: null, currentStock: 0, reorderPoint: 5 }),
        ],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
      expect(email.sendLowStockDigest).toHaveBeenCalledWith({
        to: "admin@acme.example",
        businessName: "Acme Wholesale",
        items: [
          { name: "Low Widget", sku: "LOW-1", currentStock: 2, reorderPoint: 10 },
          { name: "Zero Widget", sku: null, currentStock: 0, reorderPoint: 5 },
        ],
      });
    });

    it("REG-N4: queries only active products with a reorderPoint set, then filters strictly below it in JS (same predicate as inventory.service.ts#getForecasting)", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [
          product({ name: "Below", currentStock: 4, reorderPoint: 5 }), // included
          product({ name: "Exactly at", currentStock: 5, reorderPoint: 5 }), // strictly-less, excluded
          product({ name: "Above", currentStock: 20, reorderPoint: 5 }), // excluded
        ],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: "t1",
            isActive: true,
            reorderPoint: { not: null },
          }),
        }),
      );
      const sent = email.sendLowStockDigest.mock.calls[0][0];
      expect(sent.items.map((i: any) => i.name)).toEqual(["Below"]);
    });

    it("REG-N4: only fires within the tenant's local 07:00 hour, not other hours", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_FIVE_LOCAL);

      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(email.sendLowStockDigest).not.toHaveBeenCalled();
    });

    it("REG-N4: a tenant with no TenantConfig row falls back to America/New_York and 'RouteFlow' business name, never crashes", async () => {
      const { svc, email } = make({
        tenants: [{ id: "t1", config: null }],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledWith(
        expect.objectContaining({ businessName: "RouteFlow" }),
      );
    });
  });

  describe("empty → no mail", () => {
    it("REG-N4: zero items below threshold sends no email, but still marks the day processed", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 20, reorderPoint: 10 })], // above threshold
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).not.toHaveBeenCalled();
      expect(prisma.tenantConfig.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { lowStockDigestSentForDay: new Date("2026-09-16T00:00:00.000Z") },
      });
    });

    it("REG-N4: no products with a reorderPoint set at all sends no email and never queries admins", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(email.sendLowStockDigest).not.toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("REG-N4: already sent for today (dateKey matches lowStockDigestSentForDay) skips entirely — no product/admin/email calls, no re-write", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant({ lowStockDigestSentForDay: new Date("2026-09-16T00:00:00.000Z") })],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(email.sendLowStockDigest).not.toHaveBeenCalled();
      expect(prisma.tenantConfig.updateMany).not.toHaveBeenCalled();
    });

    it("REG-N4: a DIFFERENT prior day's mark does not block today's run", async () => {
      const { svc, email } = make({
        tenants: [tenant({ lowStockDigestSentForDay: new Date("2026-09-15T00:00:00.000Z") })],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
    });

    it("REG-N4: a second tick the same local day (e.g. a restart) is a no-op once the first tick already marked the day — simulated via the sent-day mark carried into the second call", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);
      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);

      // Simulate the persisted mark from the first run being read back on a second tick.
      prisma.tenant.findMany.mockResolvedValueOnce([
        tenant({ lowStockDigestSentForDay: new Date("2026-09-16T00:00:00.000Z") }),
      ]);
      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1); // still just the one from before
    });
  });

  describe("opt-out", () => {
    it("REG-N4: an admin with lowStockDigestEnabled=false is excluded; the other admin still receives it", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [
          makeAdmin("u1", "opted-out@acme.example"),
          makeAdmin("u2", "still-on@acme.example"),
        ],
        optOuts: [{ userId: "u1" }],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(prisma.userPreference.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ key: LOW_STOCK_DIGEST_PREF_KEY, value: "false" }),
        }),
      );
      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
      expect(email.sendLowStockDigest).toHaveBeenCalledWith(
        expect.objectContaining({ to: "still-on@acme.example" }),
      );
    });

    it("REG-N4: a missing preference row defaults to ENABLED — only an explicit 'false' opts out (B04 convention)", async () => {
      const { svc, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
        optOuts: [], // no preference row at all
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
    });

    it("REG-N4: every admin opted out ⇒ no email sent, but the day is still marked processed", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
        optOuts: [{ userId: "u1" }],
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).not.toHaveBeenCalled();
      expect(prisma.tenantConfig.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("send failure never throws", () => {
    it("REG-N4: EmailService.send rejecting (throws) for one recipient does not throw out of the tick, and the day is still marked", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
        sendImpl: async () => {
          throw new Error("boom");
        },
      });

      await expect(svc.sendLowStockDigest(AT_SEVEN_LOCAL)).resolves.toBeUndefined();
      expect(prisma.tenantConfig.updateMany).toHaveBeenCalledTimes(1);
    });

    it("REG-N4: EmailService.send returning {delivered:false} (honest failure, not a throw) does not stop processing the day mark", async () => {
      const { svc, prisma, email } = make({
        tenants: [tenant()],
        products: [product({ currentStock: 1, reorderPoint: 10 })],
        admins: [makeAdmin("u1", "admin@acme.example")],
        sendResult: { delivered: false, transport: "none", error: "no transport" },
      });

      await svc.sendLowStockDigest(AT_SEVEN_LOCAL);

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
      expect(prisma.tenantConfig.updateMany).toHaveBeenCalledTimes(1);
    });

    it("REG-N4: one tenant throwing (e.g. a bad product query) never stops the sweep for other tenants", async () => {
      const { svc, prisma, email } = make();
      prisma.tenant.findMany.mockResolvedValue([tenant({ id: "t-bad" }), tenant({ id: "t-good" })]);
      prisma.product.findMany.mockImplementation(({ where }: any) => {
        if (where.tenantId === "t-bad") throw new Error("db exploded");
        return Promise.resolve([product({ currentStock: 1, reorderPoint: 10 })]);
      });
      prisma.user.findMany.mockResolvedValue([makeAdmin("u1", "admin@acme.example")]);

      await expect(svc.sendLowStockDigest(AT_SEVEN_LOCAL)).resolves.toBeUndefined();

      expect(email.sendLowStockDigest).toHaveBeenCalledTimes(1);
      expect(email.sendLowStockDigest).toHaveBeenCalledWith(
        expect.objectContaining({ businessName: "Acme Wholesale" }),
      );
      // t-bad's failure must not have blocked t-good's day-mark either.
      expect(prisma.tenantConfig.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t-good" },
        data: expect.any(Object),
      });
    });
  });
});
