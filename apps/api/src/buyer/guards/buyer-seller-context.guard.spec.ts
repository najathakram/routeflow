import { ForbiddenException, Logger } from "@nestjs/common";
import { BuyerSellerContextGuard } from "./buyer-seller-context.guard";

// Honest stand-in for Postgres: applies the `where` the service actually sends, so a where-only fix is
// observable (L-081: a mock that injects a fixed result cannot see one). Strict: an unmodelled filter
// shape throws instead of silently matching.
function matchesWhere(row: any, where: any = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "customer") {
      const rel = (cond as any)?.is ?? cond;
      if (
        !rel ||
        !Object.prototype.hasOwnProperty.call(rel, "deletedAt") ||
        rel.deletedAt !== null
      ) {
        throw new Error(`matchesWhere: unsupported customer filter ${JSON.stringify(cond)}`);
      }
      if (row.customer.deletedAt !== null) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("has" in c) {
        if (!row[key].includes(c.has)) return false;
      } else if ("in" in c) {
        if (!c.in.includes(row[key])) return false;
      } else if ("lte" in c) {
        if (!(row[key] <= c.lte)) return false;
      } else {
        throw new Error(`matchesWhere: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");

const link = (status: string, deletedAt: Date | null) => ({
  id: "l-1",
  buyerAccountId: "b-1",
  tenantId: "tn-1",
  customerId: "c-1",
  status,
  customer: {
    id: "c-1",
    userId: "u-1",
    businessName: "Acme Deli",
    email: "buyer@example.test",
    deletedAt,
  },
});

function boot(rows: any[]) {
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "tn-1", slug: "acme", status: "ACTIVE" }),
    },
    customerLink: {
      findFirst: jest.fn(
        async (args: any) => rows.find((r) => matchesWhere(r, args?.where)) ?? null,
      ),
    },
  };
  const guard = new BuyerSellerContextGuard(prisma as any);
  const req: any = { user: { sub: "b-1" }, headers: { "x-tenant-slug": "acme" } };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req }) };
  return { guard, req, ctx };
}

describe("BuyerSellerContextGuard — removed customer (B141)", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("REG-B141 T6: the seller-context guard refuses a removed customer's ACTIVE link, and names it in the log", async () => {
    const { guard, ctx } = boot([link("ACTIVE", REMOVED_AT)]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    // The refusal is indistinguishable from a DISCONNECTED link on the wire, so the removed case is logged
    // once with the tenant + customer it refused (the stand-in answers the diagnostic lookup from the row).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("c-1");
    expect(warn.mock.calls[0][0]).toContain("tn-1");
  });

  it("B141 T6b: a refusal with no ACTIVE link at all logs nothing", async () => {
    const { guard, ctx } = boot([]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(warn).not.toHaveBeenCalled();
  });

  it("REG-B141 T7: a refused removed customer never reaches req.buyerCustomer", async () => {
    const { guard, req, ctx } = boot([link("ACTIVE", REMOVED_AT)]);
    await guard.canActivate(ctx).catch(() => undefined);
    expect(req.buyerCustomer).toBeUndefined();
  });

  it("B141 P4: a live or restored customer passes the guard and populates req.buyerCustomer", async () => {
    const { guard, req, ctx } = boot([link("ACTIVE", null)]);
    await guard.canActivate(ctx);
    expect(req.buyerCustomer.customerId).toBe("c-1");
  });

  it("B141 P5: a DISCONNECTED link is still refused for a live customer", async () => {
    const { guard, ctx } = boot([link("DISCONNECTED", null)]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
