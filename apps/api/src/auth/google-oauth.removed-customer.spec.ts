import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GoogleOAuthService } from "./google-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(),
}));

const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");

// Honest stand-in for Postgres: applies the `where` the service actually sends, so a
// where-only fix is observable (L-081: a mock that injects a fixed count cannot see one).
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
    if (row[key] !== cond) return false;
  }
  return true;
}

/**
 * The Google sign-in response's `sellerCount` selects a UI branch on mobile
 * (apps/mobile/app/(auth)/customer-login.tsx: sellerCount === 0 shows the
 * "not connected to any supplier" message, otherwise it opens the seller picker
 * built from GET /buyer/sellers). It must therefore agree with
 * BuyerService.getSellers about what counts as a usable seller.
 */
describe("GoogleOAuthService — sellerCount excludes removed customers (B141)", () => {
  function buildService(prisma: ReturnType<typeof createMockPrisma>) {
    const config = {
      get: (key: string) => {
        if (key === "jwt")
          return {
            secret: "s",
            refreshSecret: "rs",
            expiresIn: "15m",
            refreshExpiresIn: "30d",
          };
        return undefined;
      },
    } as unknown as ConfigService;
    const jwt = {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    return new GoogleOAuthService(
      prisma as any,
      jwt,
      config,
      { send: jest.fn().mockResolvedValue(undefined) } as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
  }

  const profile = {
    type: "tenant" as const,
    context: "buyer-standalone" as const,
    googleId: "google-1",
    email: "buyer@example.test",
    name: "Buyer",
  };

  const link = (id: string, deletedAt: Date | null) => ({
    id,
    buyerAccountId: "buyer-1",
    status: "ACTIVE",
    customer: { id: `c-${id}`, deletedAt },
  });

  function boot(rows: any[]) {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "buyer@example.test",
      name: "Buyer",
      googleId: "google-1",
      passwordSet: true,
      emailVerified: true,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    prisma.customerLink.count.mockImplementation(
      (async (args: any) => rows.filter((r) => matchesWhere(r, args?.where)).length) as any,
    );
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);
    return { prisma, service: buildService(prisma) };
  }

  it("REG-B141 T11: Google sign-in's sellerCount ignores a link whose customer was removed", async () => {
    const { service } = boot([link("l-removed", REMOVED_AT)]);
    const result: any = await service.findOrCreateUser(profile as any);
    expect(result.sellerCount).toBe(0);
  });

  it("B141 P9: a live (or restored) customer's link still counts", async () => {
    const { service } = boot([link("l-live", null), link("l-removed", REMOVED_AT)]);
    const result: any = await service.findOrCreateUser(profile as any);
    expect(result.sellerCount).toBe(1);
  });
});
