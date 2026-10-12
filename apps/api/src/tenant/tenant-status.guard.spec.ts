import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { TenantStatusGuard } from "./tenant-status.guard";
import { READ_ONLY_ALLOWED_MUTATIONS } from "./read-only-registry";
import { PrismaService } from "../prisma/prisma.service";

const token = `h.${Buffer.from(JSON.stringify({ tenantId: "t1" })).toString("base64url")}.s`;

const buyerToken = `h.${Buffer.from(JSON.stringify({ tenantId: "t1", role: "CUSTOMER" })).toString("base64url")}.s`;

function ctx(method: string, path: string, bearer: string = token): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${bearer}` }, method, path };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function guardFor(status: string, readOnlyReason: string | null = null) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ status, readOnlyReason }) },
  };
  return new TenantStatusGuard(prisma as unknown as PrismaService);
}

describe("TenantStatusGuard — READ_ONLY enforcement", () => {
  it("allows any GET while READ_ONLY (reads + exports still work)", async () => {
    await expect(guardFor("READ_ONLY").canActivate(ctx("GET", "/api/v1/orders"))).resolves.toBe(
      true,
    );
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("GET", "/api/v1/billing/export")),
    ).resolves.toBe(true);
  });

  it("blocks a mutating request while READ_ONLY with a structured READ_ONLY 403", async () => {
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/orders"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
  });

  it("the READ_ONLY 403 body carries the tenant's readOnlyReason (SA-776), null when none", async () => {
    const withReason = await guardFor("READ_ONLY", "trial_expired")
      .canActivate(ctx("POST", "/api/v1/orders"))
      .catch((e) => e);
    expect(withReason).toBeInstanceOf(ForbiddenException);
    expect(withReason.getResponse()).toEqual(
      expect.objectContaining({ code: "READ_ONLY", reason: "trial_expired" }),
    );
    const none = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/orders"))
      .catch((e) => e);
    expect(none.getResponse()).toEqual(
      expect.objectContaining({ code: "READ_ONLY", reason: null }),
    );
  });

  it("the reason survives the cache and a DB blip (the stale status keeps its reason)", async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ status: "READ_ONLY", readOnlyReason: "payment_overdue" })
      .mockRejectedValue(new Error("db down"));
    const guard = new TenantStatusGuard({ tenant: { findUnique } } as unknown as PrismaService);
    const first = await guard.canActivate(ctx("POST", "/api/v1/orders")).catch((e) => e);
    expect(first.getResponse().reason).toBe("payment_overdue");
    const cached = await guard.canActivate(ctx("POST", "/api/v1/orders")).catch((e) => e);
    expect(cached.getResponse().reason).toBe("payment_overdue");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("allows an allow-listed mutation (POST /billing/portal) and refuses SUSPENDED on a GET (SA-776 pins)", async () => {
    await expect(
      guardFor("READ_ONLY", "trial_expired").canActivate(ctx("POST", "/api/v1/billing/portal")),
    ).resolves.toBe(true);
    await expect(
      guardFor("SUSPENDED").canActivate(ctx("GET", "/api/v1/orders")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows subscribe/upgrade + auth mutations while READ_ONLY (so the tenant can restore access)", async () => {
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/billing/subscribe")),
    ).resolves.toBe(true);
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/billing/subscription")),
    ).resolves.toBe(true);
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/auth/login")),
    ).resolves.toBe(true);
  });

  it("allows closing the day while READ_ONLY, and ONLY the anchored day-close endpoints (owner ruling 2026-10-10)", async () => {
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/orders/counter-sale/day-close")),
    ).resolves.toBe(true);
    for (const blocked of [
      "/api/v1/orders/counter-sale", // a sale stays blocked
      "/api/v1/orders/counter-sale/day-close/x/reopen", // not a uuid
      "/api/v1/orders/counter-sale/day-close/11111111-1111-1111-1111-111111111111/report/", // anchored: no trailing slash
      "/api/v1/orders/counter-sale/day-close/11111111-1111-1111-1111-111111111111/reopen/",
      "/api/v1/orders/counter-sale/day-close/11111111-1111-1111-1111-111111111111/reopen/x",
      "/api/v1/orders/counter-sale/day-close/",
      "/api/v1/orders/counter-sale/day-closed",
    ]) {
      const err = await guardFor("READ_ONLY")
        .canActivate(ctx("POST", blocked))
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
    }
  });

  it("the reopen is allowed, the Z-report re-send is allowed (SA r-note 10-10), a sale is still refused (SA-750r3 O1)", async () => {
    await expect(
      guardFor("READ_ONLY").canActivate(
        ctx(
          "POST",
          "/api/v1/orders/counter-sale/day-close/11111111-1111-1111-1111-111111111111/reopen",
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      guardFor("READ_ONLY").canActivate(
        ctx(
          "POST",
          "/api/v1/orders/counter-sale/day-close/11111111-1111-1111-1111-111111111111/report",
        ),
      ),
    ).resolves.toBe(true);
    // a read-only tenant's sale is still refused
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/orders/counter-sale"))
      .catch((e) => e);
    expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
  });

  it("the day-close exemption is POST only: DELETE, PUT and PATCH on that exact path stay blocked", async () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const err = await guardFor("READ_ONLY")
        .canActivate(ctx(method, "/api/v1/orders/counter-sale/day-close"))
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
    }
  });

  it("allows /billing/quote while READ_ONLY (the plan-change classifier /choose-plan fires before subscribe)", async () => {
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/billing/quote")),
    ).resolves.toBe(true);
  });

  it("still blocks an unrelated mutation while READ_ONLY (guard on the guard)", async () => {
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/orders"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
  });

  it("does not exempt an unrelated path that merely contains an allowlisted substring", async () => {
    // /authorization-overrides is not /auth/ — anchored startsWith must block it while READ_ONLY.
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/authorization-overrides")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("still hard-blocks SUSPENDED / CANCELLED on every method", async () => {
    await expect(
      guardFor("SUSPENDED").canActivate(ctx("GET", "/api/v1/orders")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardFor("CANCELLED").canActivate(ctx("GET", "/api/v1/orders")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows everything for ACTIVE tenants", async () => {
    await expect(guardFor("ACTIVE").canActivate(ctx("POST", "/api/v1/orders"))).resolves.toBe(true);
  });
});

// SA-733r6 (B4) + SA-750r3 O1: the read-only allow-list is ONE data constant, pinned entry by entry.
// A read-only tenant keeps housekeeping on cash already taken (the day close, a receipt e-mail) and the admin's
// billing portal; it never gets sales, orders, invoices or payments.
describe("TenantStatusGuard - READ_ONLY allow-list (B4 pin)", () => {
  const ALLOWED: Array<[string, string]> = [
    ["POST", "/api/v1/billing/portal"],
    ["POST", "/api/v1/billing/subscription"],
    ["POST", "/api/v1/billing/subscription/downgrade"],
    ["POST", "/api/v1/billing/subscription/cancel"],
    ["POST", "/api/v1/billing/subscription/resume"],
    ["POST", "/api/v1/billing/subscription/checkout"],
    ["POST", "/api/v1/orders/counter-sale/day-close"],
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/reopen"],
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/report"],
    ["POST", "/api/v1/orders/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/receipt"],
  ];
  const BLOCKED: Array<[string, string]> = [
    ["POST", "/api/v1/invoices/inv1/payments"],
    // SA ruling: staff approving a buyer's cash request is a staff PAYMENT write - still READ_ONLY (the buyer's own
    // declaration is exempt at the buyer seller-context guard, a different guard)
    ["POST", "/api/v1/payment-requests/pr1/approve"],
    ["POST", "/api/v1/orders"],
    ["POST", "/api/v1/orders/counter-sale"],
    ["POST", "/api/v1/orders/counter-sale/o1/void"],
    ["POST", "/api/v1/orders/counter-sale/tender"],
    ["POST", "/api/v1/estimates"],
    ["POST", "/api/v1/invoices"],
    ["PATCH", "/api/v1/invoices/inv1/payments/p1"],
    // anchored, not substring: neighbours of the allowed routes stay blocked
    ["POST", "/api/v1/billing/portal-evil"],
    ["POST", "/api/v1/orders/counter-sale/day-close-evil"],
    ["POST", "/api/v1/orders/o1/receipt/extra"],
    ["POST", "/api/v1/orders/o1/receipts"],
    ["DELETE", "/api/v1/orders/counter-sale/day-close"],
    // SA ruling: there is NO /reclose (the re-close is the same POST); the id is a UUID, nothing looser
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/reclose"],
    ["POST", "/api/v1/orders/counter-sale/day-close/not-a-uuid/reopen"],
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab"],
    // the plan-restore paths are POST-only (a read passes anyway); nothing else rides on the prefix
    ["DELETE", "/api/v1/billing/subscription"],
    ["POST", "/api/v1/billing/subscription/anything-else"],
    ["POST", "/api/v1/billing/subscription/cancel/extra"],
    // the receipt id is a UUID, nothing looser
    ["POST", "/api/v1/orders/o1/receipt"],
    ["PUT", "/api/v1/billing/subscription/cancel"],
  ];

  it.each(ALLOWED)("allows %s %s while READ_ONLY", async (method, path) => {
    await expect(guardFor("READ_ONLY").canActivate(ctx(method, path))).resolves.toBe(true);
  });

  it.each(BLOCKED)("blocks %s %s while READ_ONLY with the READ_ONLY code", async (method, path) => {
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx(method, path))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
  });

  it("pins the allow-list entries EXACTLY (anchored patterns, each with a reason)", () => {
    expect(READ_ONLY_ALLOWED_MUTATIONS.map((e) => [e.method, e.pattern])).toEqual([
      ["ANY", /^\/api\/v1\/auth\//],
      ["POST", /^\/api\/v1\/billing\/subscribe$/],
      ["POST", /^\/api\/v1\/billing\/quote$/],
      ["POST", /^\/api\/v1\/billing\/subscription$/],
      ["POST", /^\/api\/v1\/billing\/subscription\/(downgrade|cancel|resume|checkout)$/],
      ["POST", /^\/api\/v1\/billing\/portal$/],
      ["POST", /^\/api\/v1\/orders\/counter-sale\/day-close$/],
      ["POST", /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/reopen$/],
      ["POST", /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/report$/],
      ["POST", /^\/api\/v1\/orders\/[0-9a-fA-F-]{36}\/receipt$/],
    ]);
  });
});

// SA-733r6 (B4) / SA-733 D11: a buyer's write to a read-only (paused) seller is 403 SELLER_UNAVAILABLE, a coded,
// seller-neutral refusal - never the staff-facing READ_ONLY text that talks about subscribing.
describe("TenantStatusGuard - buyer writes to a read-only seller (B4)", () => {
  it("refuses a buyer's POST with SELLER_UNAVAILABLE and no billing wording", async () => {
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/buyer/orders", buyerToken))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as { code: string; message: string };
    expect(body.code).toBe("SELLER_UNAVAILABLE");
    expect(body.message).not.toMatch(/payment|billing|subscribe|plan/i);
  });

  it("still lets a buyer read and sign in while the seller is read-only", async () => {
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("GET", "/api/v1/buyer/products", buyerToken)),
    ).resolves.toBe(true);
    await expect(
      guardFor("READ_ONLY").canActivate(ctx("POST", "/api/v1/auth/refresh", buyerToken)),
    ).resolves.toBe(true);
  });

  it("a staff user's blocked write keeps the READ_ONLY code", async () => {
    const err = await guardFor("READ_ONLY")
      .canActivate(ctx("POST", "/api/v1/orders"))
      .catch((e) => e);
    expect((err.getResponse() as { code: string }).code).toBe("READ_ONLY");
  });
});
