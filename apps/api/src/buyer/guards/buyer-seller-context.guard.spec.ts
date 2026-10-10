import { ForbiddenException, Logger } from "@nestjs/common";
import {
  BuyerSellerContextGuard,
  SELLER_READ_ONLY_EXEMPT_BUYER_WRITES,
} from "./buyer-seller-context.guard";

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
    if (key === "buyerAccount") {
      // #2142 R1: the buyer's own account, a to-one relation filter.
      const rel = (cond as any)?.is ?? cond;
      const keys = rel ? Object.keys(rel).sort().join(",") : "";
      if (keys !== "deletedAt,status" || rel.status !== "ACTIVE" || rel.deletedAt !== null) {
        throw new Error(`matchesWhere: unsupported buyerAccount filter ${JSON.stringify(cond)}`);
      }
      if (row.buyerAccount.status !== "ACTIVE" || row.buyerAccount.deletedAt !== null) return false;
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

const link = (
  status: string,
  deletedAt: Date | null,
  buyerAccount: { status: string; deletedAt: Date | null } = { status: "ACTIVE", deletedAt: null },
) => ({
  id: "l-1",
  buyerAccountId: "b-1",
  buyerAccount,
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

function boot(rows: any[], opts: { tenantStatus?: string; method?: string; path?: string } = {}) {
  const prisma = {
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: "tn-1", slug: "acme", status: opts.tenantStatus ?? "ACTIVE" }),
    },
    customerLink: {
      findFirst: jest.fn(
        async (args: any) => rows.find((r) => matchesWhere(r, args?.where)) ?? null,
      ),
    },
  };
  const guard = new BuyerSellerContextGuard(prisma as any);
  // The REAL buyer token shape (BuyerJwtPayload): `type: "BUYER"`, a sub, and NO tenantId / role claim - which is
  // why the global TenantStatusGuard (it reads tenantId from the JWT) never sees a buyer.
  const req: any = {
    user: { sub: "b-1", email: "buyer@example.test", name: "Buyer", type: "BUYER" },
    headers: { "x-tenant-slug": "acme" },
    method: opts.method,
    path: opts.path,
  };
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

describe("BuyerSellerContextGuard — the buyer's own account (#2142 R1)", () => {
  // BuyerAdminService.setBuyerStatus flips the account only and leaves every link ACTIVE, so the
  // guard must read the account itself, or a suspended buyer keeps the portal for the rest of its
  // access token's life.
  it("#2142 R1: a SUSPENDED account's ACTIVE link is refused", async () => {
    const { guard, req, ctx } = boot([
      link("ACTIVE", null, { status: "SUSPENDED", deletedAt: null }),
    ]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(req.buyerCustomer).toBeUndefined();
  });

  it("#2142 R1: a DELETED account's ACTIVE link is refused", async () => {
    const { guard, req, ctx } = boot([
      link("ACTIVE", null, { status: "DELETED", deletedAt: REMOVED_AT }),
    ]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(req.buyerCustomer).toBeUndefined();
  });

  it("an ACTIVE account with its link ACTIVE still passes", async () => {
    const { guard, req, ctx } = boot([link("ACTIVE", null, { status: "ACTIVE", deletedAt: null })]);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.buyerCustomer.customerId).toBe("c-1");
  });
});

// SA-733r6 (B4) B1: the SERVER refuses a buyer's write to a read-only seller. The buyer UI line is only a courtesy;
// a real buyer token carries no tenantId, so the global TenantStatusGuard cannot do this - this guard can, because
// it has just resolved the seller. One boolean-grade refusal: coded SELLER_UNAVAILABLE, neutral wording, never the
// reason (payment_overdue, trial_expired, cancelled ... all look the same to a buyer).
describe("BuyerSellerContextGuard - a read-only seller (B4)", () => {
  const live = () => [link("ACTIVE", null)];

  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "%s to a READ_ONLY seller -> 403 SELLER_UNAVAILABLE with no billing wording",
    async (method) => {
      const { guard, req, ctx } = boot(live(), { tenantStatus: "READ_ONLY", method });
      const err: any = await guard.canActivate(ctx).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = err.getResponse();
      expect(body.code).toBe("SELLER_UNAVAILABLE");
      expect(body.message).not.toMatch(/payment|billing|subscri|plan|overdue|trial|cancel/i);
      expect(req.buyerCustomer).toBeUndefined();
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"])(
    "%s to a READ_ONLY seller still passes (browse, view)",
    async (method) => {
      const { guard, req, ctx } = boot(live(), { tenantStatus: "READ_ONLY", method });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.buyerCustomer.customerId).toBe("c-1");
    },
  );

  it("a POST to an ACTIVE or TRIAL seller passes", async () => {
    for (const tenantStatus of ["ACTIVE", "TRIAL"]) {
      const { guard, ctx } = boot(live(), { tenantStatus, method: "POST" });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
  });

  it("a buyer who is not linked still gets the ordinary refusal, not SELLER_UNAVAILABLE", async () => {
    const { guard, ctx } = boot([], { tenantStatus: "READ_ONLY", method: "POST" });
    const err: any = await guard.canActivate(ctx).catch((e) => e);
    expect(err.getResponse().code).not.toBe("SELLER_UNAVAILABLE");
  });
});

// SA ruling (option a): a buyer may still PAY a read-only seller - the seller is owed the money and the payment is
// the buyer's own money moving to the seller's Stripe account or a cash declaration. The exemption is ONE named
// constant of exact method + route; orders, the cart and every other buyer write stay SELLER_UNAVAILABLE.
describe("BuyerSellerContextGuard - read-only seller: payments exempt, everything else refused (B4)", () => {
  const live = () => [link("ACTIVE", null)];
  const run = (method: string, path: string) =>
    boot(live(), { tenantStatus: "READ_ONLY", method, path });

  it("pins the exemption constant EXACTLY", () => {
    expect(SELLER_READ_ONLY_EXEMPT_BUYER_WRITES.map((e) => [e.method, e.pattern])).toEqual([
      ["POST", /^\/api\/v1\/buyer\/payments\/card$/],
      ["POST", /^\/api\/v1\/buyer\/payments\/cash$/],
      ["POST", /^\/api\/v1\/buyer\/payments\/requests\/[^/]+\/cancel$/],
    ]);
  });

  it.each([
    ["POST", "/api/v1/buyer/payments/card"],
    ["POST", "/api/v1/buyer/payments/cash"],
    ["POST", "/api/v1/buyer/payments/requests/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/cancel"],
  ])(
    "%s %s passes for a READ_ONLY seller and populates the buyer context",
    async (method, path) => {
      const { guard, req, ctx } = run(method, path);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.buyerCustomer.customerId).toBe("c-1");
    },
  );

  it.each([
    ["POST", "/api/v1/buyer/orders"],
    ["PATCH", "/api/v1/buyer/orders/o1/items"],
    ["POST", "/api/v1/buyer/orders/o1/cancel"],
    ["POST", "/api/v1/buyer/templates/t1/reorder"],
    ["POST", "/api/v1/buyer/favorites/p1"],
    // look-alikes of the exempt routes stay refused
    ["POST", "/api/v1/buyer/payments/card/extra"],
    ["POST", "/api/v1/buyer/payments/cashx"],
    ["POST", "/api/v1/buyer/payments/cash/"],
    ["PUT", "/api/v1/buyer/payments/card"],
    ["DELETE", "/api/v1/buyer/payments/cash"],
    ["PATCH", "/api/v1/buyer/payments/requests/r1/cancel"],
    ["POST", "/api/v1/buyer/payments/requests/r1/other/cancel"],
    ["POST", "/api/v1/buyer/payments/requests/r1/approve"],
    ["POST", "/api/v1/x/api/v1/buyer/payments/card"],
  ])("%s %s is still SELLER_UNAVAILABLE", async (method, path) => {
    const { guard, ctx } = run(method, path);
    const err: any = await guard.canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe("SELLER_UNAVAILABLE");
  });

  it("a query string on an exempt route does not change the verdict", async () => {
    const { guard, ctx } = run("POST", "/api/v1/buyer/payments/card?x=1");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
