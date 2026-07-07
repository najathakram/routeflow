import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { TenantStatusGuard } from "./tenant-status.guard";
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
