import { reportLowStockDigest, LowStockDigestReportDb } from "./low-stock-digest-report";

/**
 * Ops item 545 owner-run report. The counts must follow the same rules as the cron (low-stock-digest-rules.ts) and
 * the output must hold counts and a date only: no name, address, product text or id.
 */
const TENANT = "123e4567-e89b-42d3-a456-426614174000";

function make(
  data: {
    tenant?: unknown;
    activeProducts?: number;
    withPoint?: { currentStock: unknown; reorderPoint: number | null }[];
    staff?: { id: string; email: string | null }[];
    optOuts?: { userId: string }[];
    deliveries?: number;
  } = {},
) {
  const db = {
    tenant: {
      findFirst: jest.fn().mockResolvedValue(
        "tenant" in data
          ? data.tenant
          : {
              status: "ACTIVE",
              deletedAt: null,
              config: { timezone: "America/Chicago", lowStockDigestSentForDay: null },
            },
      ),
    },
    product: {
      count: jest.fn().mockResolvedValue(data.activeProducts ?? 0),
      findMany: jest.fn().mockResolvedValue(data.withPoint ?? []),
    },
    user: { findMany: jest.fn().mockResolvedValue(data.staff ?? []) },
    userPreference: { findMany: jest.fn().mockResolvedValue(data.optOuts ?? []) },
    emailDelivery: { count: jest.fn().mockResolvedValue(data.deliveries ?? 0) },
  };
  return { db, run: () => reportLowStockDigest(db as unknown as LowStockDigestReportDb, TENANT) };
}

describe("reportLowStockDigest (ops 545)", () => {
  it("counts products: active, with a reorder point, and strictly below it", async () => {
    const { run } = make({
      activeProducts: 40,
      withPoint: [
        { currentStock: 4, reorderPoint: 5 }, // below
        { currentStock: "5", reorderPoint: 5 }, // at the point: not below (Decimal-like string too)
        { currentStock: 0, reorderPoint: 1 }, // below
        { currentStock: 20, reorderPoint: 5 },
      ],
    });
    expect((await run()).products).toEqual({
      active: 40,
      withReorderPoint: 4,
      belowReorderPoint: 2,
    });
  });

  it("counts recipients the way the cron does: email on file, opt-outs, one mailbox per address", async () => {
    const { run } = make({
      staff: [
        { id: "u1", email: "a@x.example" },
        { id: "u2", email: "A@X.example" }, // same mailbox, other casing
        { id: "u3", email: null }, // no email: never a recipient
        { id: "u4", email: "d@x.example" }, // opted out
        { id: "u5", email: "e@x.example" },
      ],
      optOuts: [{ userId: "u4" }],
    });
    expect((await run()).recipients).toEqual({
      adminsAndOperators: 5,
      withEmail: 4,
      optedOut: 1,
      mailboxesToSend: 2,
    });
  });

  it("reads candidates and opt-outs through the cron's own rules", async () => {
    const { db, run } = make({ staff: [{ id: "u1", email: "a@x.example" }] });
    await run();
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        role: { in: ["TENANT_ADMIN", "OPERATOR"] },
        status: "ACTIVE",
        deletedAt: null,
      },
      select: { id: true, email: true },
    });
    expect(db.userPreference.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ["u1"] }, key: "lowStockDigestEnabled", value: "false" },
      select: { userId: true },
    });
    expect(db.product.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, isActive: true, reorderPoint: { not: null } },
      select: { currentStock: true, reorderPoint: true },
    });
  });

  it("skips the opt-out read when nobody has an email", async () => {
    const { db, run } = make({ staff: [{ id: "u1", email: null }] });
    const r = await run();
    expect(db.userPreference.findMany).not.toHaveBeenCalled();
    expect(r.recipients).toEqual({
      adminsAndOperators: 1,
      withEmail: 0,
      optedOut: 0,
      mailboxesToSend: 0,
    });
  });

  it("reports the stored zone, and UTC when the stored zone is missing or not a zone", async () => {
    const ok = await make().run();
    expect(ok.timezone).toEqual({
      stored: "America/Chicago",
      used: "America/Chicago",
      fellBackToUtc: false,
    });
    const bad = await make({
      tenant: {
        status: "ACTIVE",
        deletedAt: null,
        config: { timezone: "Not/AZone", lowStockDigestSentForDay: null },
      },
    }).run();
    expect(bad.timezone).toEqual({ stored: "Not/AZone", used: "UTC", fellBackToUtc: true });
    const none = await make({
      tenant: { status: "ACTIVE", deletedAt: null, config: null },
    }).run();
    expect(none.timezone).toEqual({ stored: null, used: "UTC", fellBackToUtc: true });
  });

  it("says whether the cron visits the tenant: not when deleted, suspended or cancelled", async () => {
    const visits = async (status: string, deletedAt: Date | null) =>
      (await make({ tenant: { status, deletedAt, config: null } }).run()).tenant.cronVisits;
    expect(await visits("ACTIVE", null)).toBe(true);
    expect(await visits("TRIAL", null)).toBe(true);
    expect(await visits("SUSPENDED", null)).toBe(false);
    expect(await visits("CANCELLED", null)).toBe(false);
    expect(await visits("ACTIVE", new Date())).toBe(false);
  });

  it("an unknown tenant id reports found: false and zero counts, without throwing", async () => {
    const r = await make({ tenant: null }).run();
    expect(r.tenant).toEqual({ found: false, cronVisits: false, status: null });
    expect(r.timezone).toEqual({ stored: null, used: null, fellBackToUtc: false });
  });

  it("with no delivery rows it says there is no per-send record, and the day mark is not proof of a send", async () => {
    const r = await make({
      tenant: {
        status: "ACTIVE",
        deletedAt: null,
        config: { timezone: "UTC", lowStockDigestSentForDay: new Date("2026-11-02T00:00:00.000Z") },
      },
    }).run();
    expect(r.sendRecord.lastProcessedDay).toBe("2026-11-02");
    expect(r.sendRecord.dayMarkProvesSend).toBe(false);
    expect(r.sendRecord.deliveryRows).toBe(0);
    expect(r.sendRecord.note).toMatch(/No per-send record is kept/);
  });

  it("counts delivery rows of the digest kind when there are some, and reads none as a day mark", async () => {
    const { db, run } = make({ deliveries: 3 });
    const r = await run();
    expect(db.emailDelivery.count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, kind: "LOW_STOCK_DIGEST" },
    });
    expect(r.sendRecord.deliveryRows).toBe(3);
    expect(r.sendRecord.lastProcessedDay).toBeNull();
    expect(r.sendRecord.note).not.toMatch(/No per-send record is kept/);
  });

  it("returns counts and a date only: no address, product text or tenant id in the output", async () => {
    const { run } = make({
      activeProducts: 2,
      withPoint: [{ currentStock: 1, reorderPoint: 5 }],
      staff: [{ id: "user-secret-id", email: "owner@client-business.example" }],
      optOuts: [],
    });
    const text = JSON.stringify(await run());
    expect(text).not.toContain("client-business");
    expect(text).not.toContain("owner@");
    expect(text).not.toContain("user-secret-id");
    expect(text).not.toContain(TENANT);
  });
});
