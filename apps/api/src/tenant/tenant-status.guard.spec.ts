import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { TenantStatusGuard, READ_ONLY_ALLOWED_MUTATIONS } from "./tenant-status.guard";
import { PrismaService } from "../prisma/prisma.service";

const token = `h.${Buffer.from(JSON.stringify({ tenantId: "t1" })).toString("base64url")}.s`;

function ctx(method: string, path: string): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${token}` }, method, path };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function guardFor(status: string) {
  const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue({ status }) } };
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
    ["POST", "/api/v1/orders/counter-sale/day-close"],
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/reopen"],
    ["POST", "/api/v1/orders/counter-sale/day-close/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/reclose"],
    ["POST", "/api/v1/orders/0b1f2c3d-aaaa-bbbb-cccc-1234567890ab/receipt"],
  ];
  const BLOCKED: Array<[string, string]> = [
    ["POST", "/api/v1/invoices/inv1/payments"],
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

  it("exports the allow-list as data (exact entries) so a new entry is a reviewed one-line diff", () => {
    expect(READ_ONLY_ALLOWED_MUTATIONS).toHaveLength(8);
  });
});
